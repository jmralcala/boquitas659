import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTables, createTestPool, createUser, resetDatabase } from "../integration/helpers/db.js";
import { anonymousForm, createTestApp, loginRequest, postForm, type TestApp } from "../integration/helpers/app.js";

const pool = createTestPool();
const MINUTE = 60_000;
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

async function requestReset(email: string, ip?: string) {
  const { cookie, token } = await anonymousForm(t.app, "/recuperar");
  return postForm(t.app, "/recuperar", { email, _csrf: token }, cookie, ip);
}

/** Pide la recuperación, procesa el outbox y devuelve el token del enlace recibido por correo. */
async function resetTokenFor(email: string): Promise<string> {
  await requestReset(email);
  await t.runOutbox();
  const message = [...t.transport.sent].reverse().find((m) => m.to === email && /\/recuperar\//.test(m.text));
  const token = /\/recuperar\/([A-Za-z0-9_-]{43})/.exec(message?.text ?? "")?.[1];
  if (!token) throw new Error("No llegó el enlace de recuperación.");
  return token;
}

/** Abre el formulario (como el navegador) y devuelve la cookie y el token CSRF, para enviarlo después. */
function openResetForm(token: string) {
  return anonymousForm(t.app, `/recuperar/${token}`);
}

async function submitNewPassword(
  token: string,
  fields: Record<string, string>,
  options: { withCsrf?: boolean; form?: { cookie: string; token: string } } = {},
) {
  const form = options.form ?? (await openResetForm(token));
  const withCsrf = options.withCsrf ?? true;
  return postForm(t.app, `/recuperar/${token}`, { ...fields, ...(withCsrf ? { _csrf: form.token } : {}) }, form.cookie);
}

const NEW_PASSWORD = "una contraseña nueva y larga 2026";

describe("POST /recuperar", () => {
  it("responde exactamente igual exista o no la cuenta, y solo encola correo si existe", async () => {
    const user = await createUser(pool, { email: "real@example.com" });
    const known = await requestReset(user.email);
    const unknown = await requestReset("fantasma@example.com");

    expect(known.statusCode).toBe(200);
    expect(unknown.statusCode).toBe(200);
    const clean = (body: string) => body.replace(/name="_csrf" value="[^"]+"/, "").replace(/value="[^"]*"/g, "");
    expect(clean(known.body)).toBe(clean(unknown.body));

    const outbox = await rows("SELECT template, to_email FROM email_outbox");
    expect(outbox).toEqual([{ template: "password_reset", to_email: "real@example.com" }]);
  });

  it("una cuenta deshabilitada recibe la misma respuesta y no se le envía correo", async () => {
    const user = await createUser(pool, { status: "disabled" });
    expect((await requestReset(user.email)).statusCode).toBe(200);
    expect(await rows("SELECT COUNT(*) AS n FROM email_outbox")).toEqual([{ n: 0 }]);
  });

  it("normaliza el correo y rechaza formatos inválidos sin revelar nada", async () => {
    const user = await createUser(pool, { email: "real@example.com" });
    expect((await requestReset("  REAL@Example.com ")).statusCode).toBe(200);
    expect(await rows("SELECT COUNT(*) AS n FROM email_outbox")).toEqual([{ n: 1 }]);
    expect((await requestReset("no-es-correo")).statusCode).toBe(200);
    expect(await rows("SELECT COUNT(*) AS n FROM email_outbox")).toEqual([{ n: 1 }]);
    expect(user.id).toBeGreaterThan(0);
  });

  it("limita las peticiones por IP: la sexta en una hora recibe 429", async () => {
    const ip = "198.51.100.150";
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await requestReset("alguien@example.com", ip)).statusCode);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });

  it("exige token CSRF", async () => {
    const response = await postForm(t.app, "/recuperar", { email: "alguien@example.com" });
    expect(response.statusCode).toBe(403);
  });

  it("el correo lleva un enlace de un solo uso que caduca en 30 minutos", async () => {
    const user = await createUser(pool, { email: "real@example.com" });
    await requestReset(user.email);
    expect(await rows("SELECT COUNT(*) AS n FROM one_time_token")).toEqual([{ n: 0 }]); // el token nace al enviar
    await t.runOutbox();
    const [token] = await rows("SELECT purpose, expires_at, created_at FROM one_time_token");
    expect(token?.purpose).toBe("password_reset");
    expect((token?.expires_at as Date).getTime() - (token?.created_at as Date).getTime()).toBe(30 * MINUTE);
    expect(t.transport.sent[0]?.text).toContain("30 minutos");
  });
});

describe("GET /recuperar/:token", () => {
  it("muestra el formulario sin consumir el token (se puede abrir varias veces)", async () => {
    const user = await createUser(pool, { email: "real@example.com" });
    const token = await resetTokenFor(user.email);
    for (let i = 0; i < 3; i += 1) {
      const response = await t.app.inject({ method: "GET", url: `/recuperar/${token}` });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('name="password"');
    }
    expect(await rows("SELECT COUNT(*) AS n FROM one_time_token WHERE used_at IS NOT NULL")).toEqual([{ n: 0 }]);
  });

  it("un token inventado o con formato inválido muestra el aviso de enlace vencido", async () => {
    for (const token of ["a".repeat(43), "corto", "x".repeat(99)]) {
      const response = await t.app.inject({ method: "GET", url: `/recuperar/${token}` });
      expect(response.statusCode).toBe(410);
      expect(response.body).toContain("venció");
      expect(response.body).toContain("/recuperar");
    }
  });

  it("un token absurdamente largo se rechaza antes de llegar a la lógica (414)", async () => {
    const response = await t.app.inject({ method: "GET", url: `/recuperar/${"x".repeat(300)}` });
    expect(response.statusCode).toBe(414);
  });

  it("a los 30 minutos el enlace ya no sirve", async () => {
    const user = await createUser(pool, { email: "real@example.com" });
    const token = await resetTokenFor(user.email);
    t.clock.advance(29 * MINUTE);
    expect((await t.app.inject({ method: "GET", url: `/recuperar/${token}` })).statusCode).toBe(200);
    t.clock.advance(2 * MINUTE);
    expect((await t.app.inject({ method: "GET", url: `/recuperar/${token}` })).statusCode).toBe(410);
  });
});

describe("POST /recuperar/:token", () => {
  it("con un token válido cambia la contraseña, revoca todas las sesiones y avisa por correo", async () => {
    const user = await createUser(pool, { email: "real@example.com" });
    const s1 = await t.services.sessions.create(user.id, { mfaVerified: true });
    const s2 = await t.services.sessions.create(user.id, { mfaVerified: true });
    const token = await resetTokenFor(user.email);

    const response = await submitNewPassword(token, { password: NEW_PASSWORD, passwordConfirm: NEW_PASSWORD });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/login");

    expect(await t.services.sessions.validate(s1.token)).toBeNull();
    expect(await t.services.sessions.validate(s2.token)).toBeNull();

    // La contraseña nueva funciona y la anterior no.
    expect((await loginRequest(t.app, user.email, NEW_PASSWORD)).statusCode).toBe(303);
    t.clock.advance(10 * MINUTE);
    expect((await loginRequest(t.app, user.email, user.password)).statusCode).toBe(401);

    expect(await rows("SELECT type FROM security_event WHERE type = 'password_reset'")).toEqual([{ type: "password_reset" }]);
    expect(await rows("SELECT template, to_email FROM email_outbox WHERE template = 'password_changed'")).toEqual([
      { template: "password_changed", to_email: "real@example.com" },
    ]);
  });

  it("el token solo sirve una vez", async () => {
    const user = await createUser(pool, { email: "real@example.com" });
    const token = await resetTokenFor(user.email);
    const firstTab = await openResetForm(token);
    const secondTab = await openResetForm(token);
    expect((await submitNewPassword(token, { password: NEW_PASSWORD, passwordConfirm: NEW_PASSWORD }, { form: firstTab })).statusCode).toBe(303);
    const again = await submitNewPassword(
      token,
      { password: "otra contraseña distinta 2026", passwordConfirm: "otra contraseña distinta 2026" },
      { form: secondTab },
    );
    expect(again.statusCode).toBe(410);
    expect(again.body).toContain("venció");
    t.clock.advance(10 * MINUTE);
    expect((await loginRequest(t.app, user.email, NEW_PASSWORD)).statusCode).toBe(303);
  });

  it("un token vencido no cambia la contraseña", async () => {
    const user = await createUser(pool, { email: "real@example.com" });
    const token = await resetTokenFor(user.email);
    const openForm = await openResetForm(token); // el formulario se abrió a tiempo...
    t.clock.advance(31 * MINUTE); // ...pero se envía después de que venció el enlace
    const response = await submitNewPassword(token, { password: NEW_PASSWORD, passwordConfirm: NEW_PASSWORD }, { form: openForm });
    expect(response.statusCode).toBe(410);
    expect((await loginRequest(t.app, user.email, user.password)).statusCode).toBe(303);
  });

  it("aplica la política de contraseñas y NO consume el token si la contraseña es rechazada", async () => {
    const user = await createUser(pool, { email: "real@example.com" });
    const token = await resetTokenFor(user.email);
    for (const password of ["corta", "1234567890", user.email]) {
      const response = await submitNewPassword(token, { password, passwordConfirm: password });
      expect(response.statusCode, password).toBe(400);
    }
    const mismatch = await submitNewPassword(token, { password: NEW_PASSWORD, passwordConfirm: "no coincide con la anterior" });
    expect(mismatch.statusCode).toBe(400);
    // El token sigue vigente.
    expect((await t.app.inject({ method: "GET", url: `/recuperar/${token}` })).statusCode).toBe(200);
    expect((await submitNewPassword(token, { password: NEW_PASSWORD, passwordConfirm: NEW_PASSWORD })).statusCode).toBe(303);
  });

  it("pedir un enlace nuevo invalida el anterior", async () => {
    const user = await createUser(pool, { email: "real@example.com" });
    const first = await resetTokenFor(user.email);
    const second = await resetTokenFor(user.email);
    expect(second).not.toBe(first);
    expect((await t.app.inject({ method: "GET", url: `/recuperar/${first}` })).statusCode).toBe(410);
    expect((await t.app.inject({ method: "GET", url: `/recuperar/${second}` })).statusCode).toBe(200);
  });

  it("exige token CSRF", async () => {
    const user = await createUser(pool, { email: "real@example.com" });
    const token = await resetTokenFor(user.email);
    const response = await submitNewPassword(token, { password: NEW_PASSWORD, passwordConfirm: NEW_PASSWORD }, { withCsrf: false });
    expect(response.statusCode).toBe(403);
    expect((await t.app.inject({ method: "GET", url: `/recuperar/${token}` })).statusCode).toBe(200);
  });

  it("dos envíos simultáneos con el mismo token: solo uno cambia la contraseña", async () => {
    const user = await createUser(pool, { email: "real@example.com" });
    const token = await resetTokenFor(user.email);
    const a = await anonymousForm(t.app, `/recuperar/${token}`);
    const b = await anonymousForm(t.app, `/recuperar/${token}`);
    const results = await Promise.all([
      postForm(t.app, `/recuperar/${token}`, { password: "primera contraseña larga 2026", passwordConfirm: "primera contraseña larga 2026", _csrf: a.token }, a.cookie),
      postForm(t.app, `/recuperar/${token}`, { password: "segunda contraseña larga 2026", passwordConfirm: "segunda contraseña larga 2026", _csrf: b.token }, b.cookie),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([303, 410]);
    expect(await rows("SELECT COUNT(*) AS n FROM security_event WHERE type = 'password_reset'")).toEqual([{ n: 1 }]);
  });
});
