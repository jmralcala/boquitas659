import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTables, createDoctor, createPatient, createTestPool, createUser, resetDatabase } from "../integration/helpers/db.js";
import { anonymousForm, createTestApp, linkTokenSentTo, loginRequest, postForm, sessionFor, type AuthedClient, type TestApp } from "../integration/helpers/app.js";

const pool = createTestPool();
let t: TestApp;

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

const NEW_PASSWORD = "una contraseña nueva y larga 2026";

function post(client: AuthedClient, url: string, fields: Record<string, string>, withCsrf = true) {
  return postForm(t.app, url, { ...fields, ...(withCsrf ? { _csrf: client.csrf } : {}) }, client.cookie);
}

describe("autenticación requerida", () => {
  it("sin sesión las pantallas responden 401", async () => {
    for (const url of ["/cuenta/contrasena", "/cuenta/correo", "/cuenta/movil-emergencia"]) {
      const response = await t.app.inject({ method: "GET", url, headers: { accept: "application/json" } });
      expect(response.statusCode, url).toBe(401);
    }
  });
});

describe("POST /cuenta/contrasena", () => {
  it("con la contraseña actual incorrecta devuelve 403, no cambia nada y cuenta como intento fallido", async () => {
    const user = await createUser(pool);
    const client = await sessionFor(t.services, user);
    const response = await post(client, "/cuenta/contrasena", { currentPassword: "no es la actual 123", newPassword: NEW_PASSWORD, newPasswordConfirm: NEW_PASSWORD });
    expect(response.statusCode).toBe(403);
    // Cuenta como intento fallido: queda registrado en el control de intentos.
    expect(await rows("SELECT failures FROM login_throttle WHERE scope = 'account'")).toEqual([{ failures: 1 }]);

    t.clock.advance(5 * 60_000);
    expect((await loginRequest(t.app, user.email, user.password)).statusCode).toBe(303); // la clave sigue siendo la original
  });

  it("un segundo intento inmediato con contraseña incorrecta queda en espera (429)", async () => {
    const client = await sessionFor(t.services, await createUser(pool));
    await post(client, "/cuenta/contrasena", { currentPassword: "mala 1234567890", newPassword: NEW_PASSWORD, newPasswordConfirm: NEW_PASSWORD });
    const second = await post(client, "/cuenta/contrasena", { currentPassword: "mala 1234567890", newPassword: NEW_PASSWORD, newPasswordConfirm: NEW_PASSWORD });
    expect(second.statusCode).toBe(429);
  });

  it("con la actual correcta cambia la contraseña, revoca las demás sesiones y conserva la actual", async () => {
    const user = await createUser(pool);
    const client = await sessionFor(t.services, user);
    const other = await sessionFor(t.services, user);

    const response = await post(client, "/cuenta/contrasena", { currentPassword: user.password, newPassword: NEW_PASSWORD, newPasswordConfirm: NEW_PASSWORD });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("actualizada");

    const current = await t.app.inject({ method: "GET", url: "/cuenta/contrasena", headers: { cookie: client.cookie } });
    expect(current.statusCode).toBe(200); // la sesión actual sigue viva
    const revoked = await t.app.inject({ method: "GET", url: "/cuenta/contrasena", headers: { cookie: other.cookie, accept: "application/json" } });
    expect(revoked.statusCode).toBe(401);

    expect((await loginRequest(t.app, user.email, NEW_PASSWORD)).statusCode).toBe(303);
    expect(await rows("SELECT type FROM security_event WHERE type = 'password_changed'")).toEqual([{ type: "password_changed" }]);
    expect(await rows("SELECT template, to_email FROM email_outbox WHERE template = 'password_changed'")).toEqual([
      { template: "password_changed", to_email: user.email },
    ]);
  });

  it("aplica la política de contraseñas y exige que la confirmación coincida", async () => {
    const user = await createUser(pool);
    const client = await sessionFor(t.services, user);
    for (const newPassword of ["corta", "1234567890", user.email]) {
      const response = await post(client, "/cuenta/contrasena", { currentPassword: user.password, newPassword, newPasswordConfirm: newPassword });
      expect(response.statusCode, newPassword).toBe(400);
    }
    const mismatch = await post(client, "/cuenta/contrasena", { currentPassword: user.password, newPassword: NEW_PASSWORD, newPasswordConfirm: "otra cosa distinta 1234" });
    expect(mismatch.statusCode).toBe(400);
    expect(await rows("SELECT COUNT(*) AS n FROM email_outbox")).toEqual([{ n: 0 }]);
  });

  it("exige token CSRF", async () => {
    const user = await createUser(pool);
    const client = await sessionFor(t.services, user);
    const response = await post(client, "/cuenta/contrasena", { currentPassword: user.password, newPassword: NEW_PASSWORD, newPasswordConfirm: NEW_PASSWORD }, false);
    expect(response.statusCode).toBe(403);
  });
});

describe("cambio de correo (se verifica el correo nuevo antes de aplicarlo)", () => {
  async function requestChange(client: AuthedClient, user: { password: string }, newEmail: string) {
    return post(client, "/cuenta/correo", { currentPassword: user.password, newEmail });
  }

  async function confirmWith(token: string, options: { logged?: AuthedClient } = {}) {
    const url = `/cuenta/correo/confirmar/${token}`;
    const form = await anonymousForm(t.app, url);
    return postForm(t.app, url, { _csrf: form.token }, form.cookie + (options.logged ? `; ${options.logged.cookie}` : ""));
  }

  it("con la contraseña actual incorrecta devuelve 403 y no pide nada", async () => {
    const user = await createUser(pool, { email: "viejo@example.com" });
    const client = await sessionFor(t.services, user);
    const response = await post(client, "/cuenta/correo", { currentPassword: "no es la actual 123", newEmail: "nuevo@example.com" });
    expect(response.statusCode).toBe(403);
    expect(await rows("SELECT email, pending_email FROM `user` WHERE id = ?", [user.id])).toEqual([{ email: "viejo@example.com", pending_email: null }]);
    expect(await rows("SELECT COUNT(*) AS n FROM email_outbox")).toEqual([{ n: 0 }]);
  });

  it("pedir el cambio NO cambia el correo de acceso: queda pendiente y se avisa a los dos correos", async () => {
    const user = await createUser(pool, { email: "viejo@example.com" });
    const client = await sessionFor(t.services, user);

    const response = await requestChange(client, user, "  Nuevo@Example.COM ");
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("nuevo@example.com");

    expect(await rows("SELECT email, email_normalized, pending_email FROM `user` WHERE id = ?", [user.id])).toEqual([
      { email: "viejo@example.com", email_normalized: "viejo@example.com", pending_email: "nuevo@example.com" },
    ]);
    const outbox = await rows("SELECT template, to_email FROM email_outbox ORDER BY template");
    expect(outbox).toEqual([
      { template: "email_change_confirm", to_email: "nuevo@example.com" },
      { template: "email_change_requested", to_email: "viejo@example.com" },
    ]);
    expect(await rows("SELECT type FROM security_event WHERE type = 'email_change_requested'")).toHaveLength(1);

    // Sigue entrando con el correo anterior y las sesiones siguen vivas.
    expect((await t.app.inject({ method: "GET", url: "/cuenta/correo", headers: { cookie: client.cookie } })).statusCode).toBe(200);
    expect((await loginRequest(t.app, "viejo@example.com", user.password)).statusCode).toBe(303);
    t.clock.advance(5 * 60_000);
    expect((await loginRequest(t.app, "nuevo@example.com", user.password)).statusCode).toBe(401);
  });

  it("el enlace llega al correo NUEVO; abrirlo no consume el token ni cambia nada", async () => {
    const user = await createUser(pool, { email: "viejo@example.com" });
    const client = await sessionFor(t.services, user);
    await requestChange(client, user, "nuevo@example.com");
    const token = await linkTokenSentTo(t, "nuevo@example.com", "/cuenta/correo/confirmar");
    expect(t.transport.sent.some((m) => m.to === "viejo@example.com" && m.text.includes("/cuenta/correo/confirmar"))).toBe(false);
    expect(t.transport.sent.find((m) => m.to === "nuevo@example.com")?.text).toContain("60 minutos");

    for (let i = 0; i < 3; i += 1) {
      const page = await t.app.inject({ method: "GET", url: `/cuenta/correo/confirmar/${token}` });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain("nuevo@example.com");
    }
    expect(await rows("SELECT email FROM `user` WHERE id = ?", [user.id])).toEqual([{ email: "viejo@example.com" }]);
    expect(await rows("SELECT COUNT(*) AS n FROM one_time_token WHERE used_at IS NOT NULL")).toEqual([{ n: 0 }]);
  });

  it("al confirmar, el correo cambia, se avisa a ambos, se cierran todas las sesiones y se entra con el nuevo", async () => {
    const user = await createUser(pool, { email: "viejo@example.com" });
    const client = await sessionFor(t.services, user);
    await requestChange(client, user, "nuevo@example.com");
    const token = await linkTokenSentTo(t, "nuevo@example.com", "/cuenta/correo/confirmar");

    const response = await confirmWith(token);
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/login");

    expect(await rows("SELECT email, email_normalized, pending_email, pending_email_normalized FROM `user` WHERE id = ?", [user.id])).toEqual([
      { email: "nuevo@example.com", email_normalized: "nuevo@example.com", pending_email: null, pending_email_normalized: null },
    ]);
    const notices = await rows("SELECT template, to_email FROM email_outbox WHERE template LIKE 'email_changed_%' ORDER BY template");
    expect(notices).toEqual([
      { template: "email_changed_new", to_email: "nuevo@example.com" },
      { template: "email_changed_old", to_email: "viejo@example.com" },
    ]);
    expect(await rows("SELECT type FROM security_event WHERE type = 'email_changed'")).toHaveLength(1);

    // La identidad cambió: la sesión abierta ya no sirve.
    expect((await t.app.inject({ method: "GET", url: "/cuenta/correo", headers: { cookie: client.cookie, accept: "application/json" } })).statusCode).toBe(401);
    expect((await loginRequest(t.app, "nuevo@example.com", user.password)).statusCode).toBe(303);
    t.clock.advance(5 * 60_000);
    expect((await loginRequest(t.app, "viejo@example.com", user.password)).statusCode).toBe(401);
  });

  it("el token solo sirve una vez y vence a los 60 minutos", async () => {
    const user = await createUser(pool, { email: "viejo@example.com" });
    const client = await sessionFor(t.services, user);

    await requestChange(client, user, "uno@example.com");
    const used = await linkTokenSentTo(t, "uno@example.com", "/cuenta/correo/confirmar");
    expect((await confirmWith(used)).statusCode).toBe(303);
    expect((await t.app.inject({ method: "GET", url: `/cuenta/correo/confirmar/${used}` })).statusCode).toBe(410);

    const client2 = await sessionFor(t.services, { ...user, email: "uno@example.com" });
    await requestChange(client2, user, "dos@example.com");
    const expiring = await linkTokenSentTo(t, "dos@example.com", "/cuenta/correo/confirmar");
    const form = await anonymousForm(t.app, `/cuenta/correo/confirmar/${expiring}`);
    t.clock.advance(61 * 60_000);
    const late = await postForm(t.app, `/cuenta/correo/confirmar/${expiring}`, { _csrf: form.token }, form.cookie);
    expect(late.statusCode).toBe(410);
    expect(await rows("SELECT email FROM `user` WHERE id = ?", [user.id])).toEqual([{ email: "uno@example.com" }]);
  });

  it("pedir otro cambio invalida el enlace anterior", async () => {
    const user = await createUser(pool, { email: "viejo@example.com" });
    const client = await sessionFor(t.services, user);
    await requestChange(client, user, "primero@example.com");
    const first = await linkTokenSentTo(t, "primero@example.com", "/cuenta/correo/confirmar");
    t.clock.advance(60_000);
    await requestChange(client, user, "segundo@example.com");
    const second = await linkTokenSentTo(t, "segundo@example.com", "/cuenta/correo/confirmar");

    expect((await t.app.inject({ method: "GET", url: `/cuenta/correo/confirmar/${first}` })).statusCode).toBe(410);
    expect((await confirmWith(second)).statusCode).toBe(303);
    expect(await rows("SELECT email FROM `user` WHERE id = ?", [user.id])).toEqual([{ email: "segundo@example.com" }]);
  });

  it("si otra cuenta ya usa ese correo, el cambio falla al confirmar con mensaje genérico y el correo no cambia", async () => {
    const user = await createUser(pool, { email: "viejo@example.com" });
    await createDoctor(pool, { email: "ocupado@example.com" });
    const client = await sessionFor(t.services, user);

    // Al pedirlo no se revela nada: la respuesta es la misma que con un correo libre.
    const requested = await requestChange(client, user, "ocupado@example.com");
    expect(requested.statusCode).toBe(200);
    const token = await linkTokenSentTo(t, "ocupado@example.com", "/cuenta/correo/confirmar");

    const response = await confirmWith(token);
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toMatch(/médico|doctor|paciente|soporte|recepci/i);
    expect(await rows("SELECT email FROM `user` WHERE id = ?", [user.id])).toEqual([{ email: "viejo@example.com" }]);
    expect(await rows("SELECT COUNT(*) AS n FROM email_outbox WHERE template = 'email_changed_old'")).toEqual([{ n: 0 }]);
  });

  it("rechaza un correo igual al actual o con formato inválido", async () => {
    const user = await createUser(pool, { email: "viejo@example.com" });
    const client = await sessionFor(t.services, user);
    for (const newEmail of ["viejo@example.com", "VIEJO@example.com", "no-es-correo"]) {
      expect((await requestChange(client, user, newEmail)).statusCode, newEmail).toBe(400);
    }
    expect(await rows("SELECT pending_email FROM `user` WHERE id = ?", [user.id])).toEqual([{ pending_email: null }]);
    expect(await rows("SELECT COUNT(*) AS n FROM email_outbox")).toEqual([{ n: 0 }]);
  });

  it("para un paciente, al confirmar se actualiza también el correo del propio paciente", async () => {
    const patient = await createPatient(pool, { email: "paciente@example.com" });
    const client = await sessionFor(t.services, patient.user);
    await requestChange(client, patient.user, "paciente.nuevo@example.com");
    const token = await linkTokenSentTo(t, "paciente.nuevo@example.com", "/cuenta/correo/confirmar");
    await confirmWith(token);
    expect(await rows("SELECT email FROM patient WHERE id = ?", [patient.patientId])).toEqual([{ email: "paciente.nuevo@example.com" }]);
  });

  it("exige token CSRF al pedir y al confirmar", async () => {
    const user = await createUser(pool);
    const client = await sessionFor(t.services, user);
    expect((await post(client, "/cuenta/correo", { currentPassword: user.password, newEmail: "x@example.com" }, false)).statusCode).toBe(403);

    await requestChange(client, user, "otro@example.com");
    const token = await linkTokenSentTo(t, "otro@example.com", "/cuenta/correo/confirmar");
    const noCsrf = await postForm(t.app, `/cuenta/correo/confirmar/${token}`, {});
    expect(noCsrf.statusCode).toBe(403);
    expect((await t.app.inject({ method: "GET", url: `/cuenta/correo/confirmar/${token}` })).statusCode).toBe(200);
  });

  it("un token con formato inválido muestra el aviso de enlace vencido", async () => {
    const response = await t.app.inject({ method: "GET", url: `/cuenta/correo/confirmar/${"a".repeat(43)}` });
    expect(response.statusCode).toBe(410);
    expect(response.body).toContain("venció");
  });
});

describe("POST /cuenta/movil-emergencia", () => {
  it("con la contraseña actual incorrecta devuelve 403 y no cambia el móvil", async () => {
    const doctor = await createDoctor(pool);
    const client = await sessionFor(t.services, doctor.user);
    const response = await post(client, "/cuenta/movil-emergencia", { currentPassword: "no es la actual 123", emergencyMobile: "5599887766" });
    expect(response.statusCode).toBe(403);
    expect(await rows("SELECT emergency_mobile FROM doctor WHERE id = ?", [doctor.doctorId])).toEqual([{ emergency_mobile: doctor.mobile }]);
  });

  it("cambia el móvil, escribe el evento y avisa al correo del médico sin mostrar el número", async () => {
    const doctor = await createDoctor(pool, { email: "dra@example.com" });
    const client = await sessionFor(t.services, doctor.user);
    const response = await post(client, "/cuenta/movil-emergencia", { currentPassword: doctor.user.password, emergencyMobile: "55 9988 7766" });
    expect(response.statusCode).toBe(200);

    expect(await rows("SELECT emergency_mobile FROM doctor WHERE id = ?", [doctor.doctorId])).toEqual([{ emergency_mobile: "5599887766" }]);
    expect(await rows("SELECT type FROM security_event WHERE type = 'emergency_mobile_changed'")).toHaveLength(1);
    expect(await rows("SELECT template, to_email FROM email_outbox")).toEqual([{ template: "emergency_mobile_changed", to_email: "dra@example.com" }]);

    await t.runOutbox();
    expect(t.transport.sent[0]?.text).not.toContain("5599887766");
    expect(t.transport.sent[0]?.text).not.toContain("9988");
  });

  it("un móvil duplicado o con formato inválido devuelve 400 y no cambia nada", async () => {
    const other = await createDoctor(pool);
    const doctor = await createDoctor(pool);
    const client = await sessionFor(t.services, doctor.user);
    for (const emergencyMobile of [other.mobile, "123", "abcdefghij", "1512345678"]) {
      const response = await post(client, "/cuenta/movil-emergencia", { currentPassword: doctor.user.password, emergencyMobile });
      expect(response.statusCode, emergencyMobile).toBe(400);
    }
    expect(await rows("SELECT emergency_mobile FROM doctor WHERE id = ?", [doctor.doctorId])).toEqual([{ emergency_mobile: doctor.mobile }]);
    expect(await rows("SELECT COUNT(*) AS n FROM email_outbox")).toEqual([{ n: 0 }]);
  });

  it("solo los médicos pueden usarla", async () => {
    const patient = await createPatient(pool);
    const client = await sessionFor(t.services, patient.user);
    expect((await post(client, "/cuenta/movil-emergencia", { currentPassword: patient.user.password, emergencyMobile: "5599887766" })).statusCode).toBe(403);
    expect((await t.app.inject({ method: "GET", url: "/cuenta/movil-emergencia", headers: { cookie: client.cookie, accept: "application/json" } })).statusCode).toBe(403);
  });

  it("exige token CSRF", async () => {
    const doctor = await createDoctor(pool);
    const client = await sessionFor(t.services, doctor.user);
    expect((await post(client, "/cuenta/movil-emergencia", { currentPassword: doctor.user.password, emergencyMobile: "5599887766" }, false)).statusCode).toBe(403);
  });
});
