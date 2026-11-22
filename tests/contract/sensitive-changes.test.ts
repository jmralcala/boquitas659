import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTables, createDoctor, createPatient, createTestPool, createUser, resetDatabase } from "../integration/helpers/db.js";
import { createTestApp, loginRequest, postForm, sessionFor, type AuthedClient, type TestApp } from "../integration/helpers/app.js";

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

describe("POST /cuenta/correo", () => {
  it("con la contraseña actual incorrecta devuelve 403 y no cambia el correo", async () => {
    const user = await createUser(pool, { email: "viejo@example.com" });
    const client = await sessionFor(t.services, user);
    const response = await post(client, "/cuenta/correo", { currentPassword: "no es la actual 123", newEmail: "nuevo@example.com" });
    expect(response.statusCode).toBe(403);
    expect(await rows("SELECT email FROM `user` WHERE id = ?", [user.id])).toEqual([{ email: "viejo@example.com" }]);
  });

  it("cambia el correo y avisa al anterior (email_changed_old) y al nuevo (email_changed_new)", async () => {
    const user = await createUser(pool, { email: "viejo@example.com" });
    const client = await sessionFor(t.services, user);
    const other = await sessionFor(t.services, user);

    const response = await post(client, "/cuenta/correo", { currentPassword: user.password, newEmail: "  Nuevo@Example.COM " });
    expect(response.statusCode).toBe(200);

    expect(await rows("SELECT email, email_normalized FROM `user` WHERE id = ?", [user.id])).toEqual([
      { email: "nuevo@example.com", email_normalized: "nuevo@example.com" },
    ]);
    const outbox = await rows("SELECT template, to_email FROM email_outbox ORDER BY template");
    expect(outbox).toEqual([
      { template: "email_changed_new", to_email: "nuevo@example.com" },
      { template: "email_changed_old", to_email: "viejo@example.com" },
    ]);
    expect(await rows("SELECT type FROM security_event WHERE type = 'email_changed'")).toHaveLength(1);

    // Cambio sensible: se cierran las demás sesiones y la actual sigue viva.
    expect((await t.app.inject({ method: "GET", url: "/cuenta/correo", headers: { cookie: other.cookie, accept: "application/json" } })).statusCode).toBe(401);
    expect((await t.app.inject({ method: "GET", url: "/cuenta/correo", headers: { cookie: client.cookie } })).statusCode).toBe(200);

    // Se puede iniciar sesión con el correo nuevo y no con el viejo.
    expect((await loginRequest(t.app, "nuevo@example.com", user.password)).statusCode).toBe(303);
    t.clock.advance(5 * 60_000);
    expect((await loginRequest(t.app, "viejo@example.com", user.password)).statusCode).toBe(401);
  });

  it("rechaza un correo igual al actual, inválido o que ya usa otra cuenta (mensaje genérico)", async () => {
    const user = await createUser(pool, { email: "viejo@example.com" });
    await createDoctor(pool, { email: "ocupado@example.com" });
    const client = await sessionFor(t.services, user);

    for (const newEmail of ["viejo@example.com", "no-es-correo", "ocupado@example.com"]) {
      const response = await post(client, "/cuenta/correo", { currentPassword: user.password, newEmail });
      expect(response.statusCode, newEmail).toBe(400);
      if (newEmail === "ocupado@example.com") {
        const mensajes = [...response.body.matchAll(/<li>(.*?)<\/li>/g)].map((m) => m[1]).join(" ");
        expect(mensajes).not.toMatch(/médico|doctor|paciente|soporte|recepci/i);
      }
    }
    expect(await rows("SELECT email FROM `user` WHERE id = ?", [user.id])).toEqual([{ email: "viejo@example.com" }]);
    expect(await rows("SELECT COUNT(*) AS n FROM email_outbox")).toEqual([{ n: 0 }]);
  });

  it("para un paciente, actualiza también el correo del propio paciente", async () => {
    const patient = await createPatient(pool, { email: "paciente@example.com" });
    const client = await sessionFor(t.services, patient.user);
    await post(client, "/cuenta/correo", { currentPassword: patient.user.password, newEmail: "paciente.nuevo@example.com" });
    expect(await rows("SELECT email FROM patient WHERE id = ?", [patient.patientId])).toEqual([{ email: "paciente.nuevo@example.com" }]);
  });

  it("exige token CSRF", async () => {
    const user = await createUser(pool);
    const client = await sessionFor(t.services, user);
    expect((await post(client, "/cuenta/correo", { currentPassword: user.password, newEmail: "x@example.com" }, false)).statusCode).toBe(403);
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
