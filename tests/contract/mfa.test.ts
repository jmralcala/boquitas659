import { generate } from "otplib";
import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTables, createDoctor, createPatient, createTestPool, createUser, resetDatabase } from "../integration/helpers/db.js";
import { anonymousForm, clientForCookie, createTestApp, loginRequest, postForm, sessionFor, type AuthedClient, type TestApp } from "../integration/helpers/app.js";

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

const codeAt = (secret: string) => generate({ secret, epoch: t.clock.now().getTime() / 1000 });
const post = (client: AuthedClient, url: string, fields: Record<string, string>) =>
  postForm(t.app, url, { ...fields, _csrf: client.csrf }, client.cookie);

/** Activa el doble factor por la interfaz y devuelve el secreto, los códigos de recuperación y la sesión vigente. */
async function enroll(user: { id: number; email: string; role: "patient" | "doctor" | "reception" | "support"; password: string }) {
  const client = await sessionFor(t.services, user);
  const start = await post(client, "/cuenta/mfa/activar", { currentPassword: user.password });
  expect(start.statusCode).toBe(200);
  const secret = /<code id="mfa-secret">([A-Z2-7]+)<\/code>/.exec(start.body)?.[1] ?? "";
  expect(secret).not.toBe("");
  const confirm = await post(client, "/cuenta/mfa/confirmar", { code: await codeAt(secret) });
  expect(confirm.statusCode).toBe(200);
  const recovery = [...confirm.body.matchAll(/<code class="recovery-code">([a-z0-9-]+)<\/code>/g)].map((m) => m[1] as string);
  const cookie = confirm.cookies.find((c) => c.name === "__Host-sid");
  return { secret, recovery, cookie: cookie ? `__Host-sid=${cookie.value}` : client.cookie, client };
}

async function loginWithMfa(email: string, password: string) {
  const first = await loginRequest(t.app, email, password);
  const session = first.cookies.find((c) => c.name === "__Host-sid");
  return { first, cookie: `__Host-sid=${session?.value}` };
}

async function submitCode(cookie: string, code: string) {
  const form = await t.app.inject({ method: "GET", url: "/login/mfa", headers: { cookie } });
  const csrf = /name="_csrf" value="([^"]+)"/.exec(form.body)?.[1] ?? "";
  return postForm(t.app, "/login/mfa", { code, _csrf: csrf }, cookie);
}

describe("activar el doble factor", () => {
  it("exige la contraseña actual para empezar y guarda el secreto cifrado, sin activarlo todavía", async () => {
    const doctor = await createDoctor(pool);
    const client = await sessionFor(t.services, doctor.user);

    const wrong = await post(client, "/cuenta/mfa/activar", { currentPassword: "no es la actual 123" });
    expect(wrong.statusCode).toBe(403);

    t.clock.advance(2000); // la contraseña incorrecta activó la espera de 1 s
    const start = await post(client, "/cuenta/mfa/activar", { currentPassword: doctor.user.password });
    expect(start.statusCode).toBe(200);
    const secret = /<code id="mfa-secret">([A-Z2-7]+)<\/code>/.exec(start.body)?.[1] ?? "";
    expect(start.body).toContain("otpauth://totp/");

    const [user] = await rows("SELECT mfa_enabled, mfa_secret_encrypted FROM `user` WHERE id = ?", [doctor.user.id]);
    expect(user?.mfa_enabled).toBe(0);
    expect(String(user?.mfa_secret_encrypted)).toMatch(/^v1:/);
    expect(String(user?.mfa_secret_encrypted)).not.toContain(secret);
  });

  it("confirmar con un código correcto activa el doble factor, entrega 10 códigos de recuperación una sola vez y avisa por correo", async () => {
    const doctor = await createDoctor(pool, { email: "dra@example.com" });
    const { recovery, client, cookie } = await enroll(doctor.user);

    expect(recovery).toHaveLength(10);
    expect((await rows("SELECT mfa_enabled FROM `user` WHERE id = ?", [doctor.user.id]))[0]?.mfa_enabled).toBe(1);
    expect(await rows("SELECT type FROM security_event WHERE type = 'mfa_enabled'")).toHaveLength(1);
    expect(await rows("SELECT template, to_email FROM email_outbox WHERE template = 'mfa_enabled'")).toEqual([
      { template: "mfa_enabled", to_email: "dra@example.com" },
    ]);

    // Los códigos de recuperación se guardan como hash, de un solo uso y nunca en claro.
    const stored = await rows("SELECT code_hash, used_at FROM mfa_recovery_code WHERE user_id = ?", [doctor.user.id]);
    expect(stored).toHaveLength(10);
    for (const row of stored) {
      expect(String(row.code_hash)).toMatch(/^[0-9a-f]{64}$/);
      expect(row.used_at).toBeNull();
    }
    expect(JSON.stringify(stored)).not.toContain(recovery[0]);

    // La sesión que activó el doble factor sigue siendo válida (se rotó ya verificada).
    const panel = await t.app.inject({ method: "GET", url: "/medicos/panel", headers: { cookie } });
    expect(panel.statusCode).toBe(200);
    // Los códigos no se vuelven a mostrar.
    const again = await t.app.inject({ method: "GET", url: "/cuenta/mfa", headers: { cookie } });
    expect(again.body).not.toContain(recovery[0]);
    expect(client.cookie).not.toBe(cookie);
  });

  it("un código incorrecto no activa nada", async () => {
    const doctor = await createDoctor(pool);
    const client = await sessionFor(t.services, doctor.user);
    await post(client, "/cuenta/mfa/activar", { currentPassword: doctor.user.password });
    const response = await post(client, "/cuenta/mfa/confirmar", { code: "000000" });
    expect(response.statusCode).toBe(400);
    expect((await rows("SELECT mfa_enabled FROM `user` WHERE id = ?", [doctor.user.id]))[0]?.mfa_enabled).toBe(0);
    expect(await rows("SELECT COUNT(*) AS n FROM mfa_recovery_code")).toEqual([{ n: 0 }]);
  });

  it("solo médicos, recepción y soporte pueden activarlo; los pacientes no (403)", async () => {
    const patient = await createPatient(pool);
    const client = await sessionFor(t.services, patient.user);
    expect((await post(client, "/cuenta/mfa/activar", { currentPassword: patient.user.password })).statusCode).toBe(403);
    for (const role of ["doctor", "reception", "support"] as const) {
      const user = role === "doctor" ? (await createDoctor(pool)).user : await createUser(pool, { role });
      const c = await sessionFor(t.services, user);
      expect((await post(c, "/cuenta/mfa/activar", { currentPassword: user.password })).statusCode, role).toBe(200);
    }
  });

  it("exige token CSRF", async () => {
    const doctor = await createDoctor(pool);
    const client = await sessionFor(t.services, doctor.user);
    const response = await postForm(t.app, "/cuenta/mfa/activar", { currentPassword: doctor.user.password }, client.cookie);
    expect(response.statusCode).toBe(403);
  });
});

describe("iniciar sesión con doble factor", () => {
  it("con TOTP activo, el inicio de sesión queda a medias y pide el código", async () => {
    const doctor = await createDoctor(pool, { email: "dra@example.com" });
    const { secret } = await enroll(doctor.user);
    t.clock.advance(60_000);

    const { first, cookie } = await loginWithMfa("dra@example.com", doctor.user.password);
    expect(first.statusCode).toBe(303);
    expect(first.headers.location).toBe("/login/mfa");

    // Con la sesión a medias no se accede a nada.
    const panel = await t.app.inject({ method: "GET", url: "/medicos/panel", headers: { cookie, accept: "application/json" } });
    expect(panel.statusCode).toBe(401);

    const ok = await submitCode(cookie, await codeAt(secret));
    expect(ok.statusCode).toBe(303);
    expect(ok.headers.location).toBe("/medicos/inicio");
    const verified = ok.cookies.find((c) => c.name === "__Host-sid");
    // La sesión se rota al subir de privilegio: el token anterior ya no sirve.
    expect(verified?.value).toBeDefined();
    expect(verified?.value).not.toBe(cookie.split("=")[1]);
    expect((await t.app.inject({ method: "GET", url: "/medicos/panel", headers: { cookie: `__Host-sid=${verified?.value}` } })).statusCode).toBe(200);
    expect((await t.app.inject({ method: "GET", url: "/medicos/panel", headers: { cookie, accept: "application/json" } })).statusCode).toBe(401);
  });

  it("un código incorrecto da 401 y cuenta como intento fallido (espera creciente)", async () => {
    const doctor = await createDoctor(pool, { email: "dra@example.com" });
    const { secret } = await enroll(doctor.user);
    t.clock.advance(60_000);
    const { cookie } = await loginWithMfa("dra@example.com", doctor.user.password);

    const wrong = await submitCode(cookie, "000000");
    expect(wrong.statusCode).toBe(401);
    const blocked = await submitCode(cookie, await codeAt(secret));
    expect(blocked.statusCode).toBe(429);
    t.clock.advance(1500);
    expect((await submitCode(cookie, await codeAt(secret))).statusCode).toBe(303);
  });

  it("un código TOTP ya usado no se puede reutilizar (replay)", async () => {
    const doctor = await createDoctor(pool, { email: "dra@example.com" });
    const { secret } = await enroll(doctor.user);
    t.clock.advance(60_000);
    const code = await codeAt(secret);

    const a = await loginWithMfa("dra@example.com", doctor.user.password);
    expect((await submitCode(a.cookie, code)).statusCode).toBe(303);

    t.clock.advance(1000); // mismo paso de 30 s
    const b = await loginWithMfa("dra@example.com", doctor.user.password);
    expect((await submitCode(b.cookie, code)).statusCode).toBe(401);
  });

  it("un código de recuperación entra una sola vez", async () => {
    const doctor = await createDoctor(pool, { email: "dra@example.com" });
    const { recovery } = await enroll(doctor.user);
    t.clock.advance(60_000);

    const a = await loginWithMfa("dra@example.com", doctor.user.password);
    expect((await submitCode(a.cookie, (recovery[0] ?? "").toUpperCase())).statusCode).toBe(303);
    expect(await rows("SELECT COUNT(*) AS n FROM mfa_recovery_code WHERE used_at IS NOT NULL")).toEqual([{ n: 1 }]);

    const b = await loginWithMfa("dra@example.com", doctor.user.password);
    expect((await submitCode(b.cookie, recovery[0] ?? "")).statusCode).toBe(401);
    t.clock.advance(5000);
    const c = await loginWithMfa("dra@example.com", doctor.user.password);
    expect((await submitCode(c.cookie, recovery[1] ?? "")).statusCode).toBe(303);
  });

  it("dos usos simultáneos del mismo código de recuperación: solo uno entra", async () => {
    const doctor = await createDoctor(pool, { email: "dra@example.com" });
    const { recovery } = await enroll(doctor.user);
    t.clock.advance(60_000);
    const a = await loginWithMfa("dra@example.com", doctor.user.password);
    const b = await loginWithMfa("dra@example.com", doctor.user.password);
    const results = await Promise.all([submitCode(a.cookie, recovery[2] ?? ""), submitCode(b.cookie, recovery[2] ?? "")]);
    expect(results.filter((r) => r.statusCode === 303)).toHaveLength(1);
  });

  it("la pantalla de código solo es para sesiones a medias; sin sesión o ya verificada redirige", async () => {
    const doctor = await createDoctor(pool);
    const client = await sessionFor(t.services, doctor.user);
    expect((await t.app.inject({ method: "GET", url: "/login/mfa", headers: { cookie: client.cookie } })).statusCode).toBe(303);
    expect((await t.app.inject({ method: "GET", url: "/login/mfa" })).statusCode).toBe(303);
  });
});

describe("desactivar el doble factor", () => {
  it("exige la contraseña actual, borra el secreto y los códigos de recuperación y avisa por correo", async () => {
    const doctor = await createDoctor(pool, { email: "dra@example.com" });
    const { cookie } = await enroll(doctor.user);
    const rotated = await clientForCookie(t.services, cookie); // la sesión que quedó tras activar el doble factor

    const wrong = await post(rotated, "/cuenta/mfa/desactivar", { currentPassword: "no es la actual 123" });
    expect(wrong.statusCode).toBe(403);
    expect((await rows("SELECT mfa_enabled FROM `user` WHERE id = ?", [doctor.user.id]))[0]?.mfa_enabled).toBe(1);

    t.clock.advance(5 * 60_000);
    const ok = await post(rotated, "/cuenta/mfa/desactivar", { currentPassword: doctor.user.password });
    expect(ok.statusCode).toBe(200);
    expect(await rows("SELECT mfa_enabled, mfa_secret_encrypted FROM `user` WHERE id = ?", [doctor.user.id])).toEqual([
      { mfa_enabled: 0, mfa_secret_encrypted: null },
    ]);
    expect(await rows("SELECT COUNT(*) AS n FROM mfa_recovery_code")).toEqual([{ n: 0 }]);
    expect(await rows("SELECT template FROM email_outbox WHERE template = 'mfa_disabled'")).toHaveLength(1);
  });

  it("soporte no puede desactivarlo (es obligatorio)", async () => {
    const support = await createUser(pool, { role: "support" });
    const { cookie } = await enroll(support);
    const client = await clientForCookie(t.services, cookie);
    const response = await post(client, "/cuenta/mfa/desactivar", { currentPassword: support.password });
    expect(response.statusCode).toBe(403);
    expect((await rows("SELECT mfa_enabled FROM `user` WHERE id = ?", [support.id]))[0]?.mfa_enabled).toBe(1);
  });
});

describe("estado en /cuenta/mfa", () => {
  it("muestra si está activo o no, sin secretos", async () => {
    const doctor = await createDoctor(pool);
    const client = await sessionFor(t.services, doctor.user);
    const off = await t.app.inject({ method: "GET", url: "/cuenta/mfa", headers: { cookie: client.cookie } });
    expect(off.statusCode).toBe(200);
    expect(off.body).toContain("/cuenta/mfa/activar");
    expect(off.body).not.toContain("mfa-secret");
    const anonymous = await anonymousForm(t.app, "/login");
    expect(anonymous.token.length).toBeGreaterThan(10);
  });
});

describe("endurecimiento del doble factor", () => {
  it("el contador de intentos NO se reinicia al repetir la contraseña: la espera sigue creciendo", async () => {
    const doctor = await createDoctor(pool, { email: "dra@example.com" });
    const { secret } = await enroll(doctor.user);
    t.clock.advance(60_000);

    const a = await loginWithMfa("dra@example.com", doctor.user.password);
    expect((await submitCode(a.cookie, "000000")).statusCode).toBe(401); // 1.er fallo: espera de 1 s
    t.clock.advance(1500);

    const b = await loginWithMfa("dra@example.com", doctor.user.password); // contraseña correcta otra vez
    expect(b.first.statusCode).toBe(303);
    expect((await submitCode(b.cookie, "000000")).statusCode).toBe(401); // 2.º fallo: espera de 2 s (no se reinició)
    t.clock.advance(1500);
    expect((await submitCode(b.cookie, await codeAt(secret))).statusCode).toBe(429); // 1,5 s < 2 s
    t.clock.advance(1000);
    expect((await submitCode(b.cookie, await codeAt(secret))).statusCode).toBe(303);
  });

  it("entrar con un código de recuperación deja evento y avisa por correo; con el TOTP no", async () => {
    const doctor = await createDoctor(pool, { email: "dra@example.com" });
    const { recovery, secret } = await enroll(doctor.user);
    t.clock.advance(60_000);

    const withTotp = await loginWithMfa("dra@example.com", doctor.user.password);
    expect((await submitCode(withTotp.cookie, await codeAt(secret))).statusCode).toBe(303);
    expect(await rows("SELECT COUNT(*) AS n FROM security_event WHERE type = 'mfa_recovery_used'")).toEqual([{ n: 0 }]);

    t.clock.advance(60_000);
    const withRecovery = await loginWithMfa("dra@example.com", doctor.user.password);
    expect((await submitCode(withRecovery.cookie, recovery[0] ?? "")).statusCode).toBe(303);
    expect(await rows("SELECT COUNT(*) AS n FROM security_event WHERE type = 'mfa_recovery_used'")).toEqual([{ n: 1 }]);
    expect(await rows("SELECT to_email FROM email_outbox WHERE template = 'mfa_recovery_used'")).toEqual([{ to_email: "dra@example.com" }]);
  });

  it("generar un secreto nuevo con el doble factor ya activo falla y no desactiva nada", async () => {
    const doctor = await createDoctor(pool);
    await enroll(doctor.user);
    await expect(t.services.mfa.beginEnrollment(doctor.user.id)).rejects.toMatchObject({ status: 409 });
    expect((await rows("SELECT mfa_enabled FROM `user` WHERE id = ?", [doctor.user.id]))[0]?.mfa_enabled).toBe(1);
  });

  it("la activación y el desactivado dejan el evento y el aviso en la misma transacción que el cambio", async () => {
    const doctor = await createDoctor(pool, { email: "dra@example.com" });
    const { cookie } = await enroll(doctor.user);
    expect(await rows("SELECT COUNT(*) AS n FROM security_event WHERE type = 'mfa_enabled'")).toEqual([{ n: 1 }]);

    const client = await clientForCookie(t.services, cookie);
    t.clock.advance(5 * 60_000);
    await post(client, "/cuenta/mfa/desactivar", { currentPassword: doctor.user.password });
    expect(await rows("SELECT COUNT(*) AS n FROM security_event WHERE type = 'mfa_disabled'")).toEqual([{ n: 1 }]);
    expect(await rows("SELECT COUNT(*) AS n FROM email_outbox WHERE template = 'mfa_disabled'")).toEqual([{ n: 1 }]);
  });
});
