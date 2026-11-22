import type { RowDataPacket } from "mysql2/promise";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/http/app.js";
import { SESSION_COOKIE } from "../../src/http/session-plugin.js";
import { createPasswordHasher, type PasswordHasher } from "../../src/modules/auth/password-hasher.js";
import { createDeviceService } from "../../src/modules/auth/devices.js";
import { createLoginThrottle } from "../../src/modules/auth/login-throttle.js";
import { registerAuthRoutes } from "../../src/modules/auth/routes.js";
import { createSessionService } from "../../src/modules/auth/sessions.js";
import { clearTables, createTestPool, createUser, resetDatabase } from "../integration/helpers/db.js";

const pool = createTestPool();
const sessions = createSessionService(pool);
const csrfSecret = "s".repeat(40);

const realHasher = createPasswordHasher("argon2", { argon2: { memoryCost: 1024, timeCost: 2, parallelism: 1 } });
const calls = { verify: 0, dummy: 0 };
const countingHasher: PasswordHasher = {
  hash: (password) => realHasher.hash(password),
  verify: (hash, password) => {
    calls.verify += 1;
    return realHasher.verify(hash, password);
  },
  needsRehash: (hash) => realHasher.needsRehash(hash),
  dummyVerify: (password) => {
    calls.dummy += 1;
    return realHasher.dummyVerify(password);
  },
};

let app: FastifyInstance;

beforeAll(async () => {
  await resetDatabase(pool);
  app = await buildApp({ appEnv: "development", sessions, csrfSecret });
  registerAuthRoutes(app, {
    db: pool,
    sessions,
    hasher: countingHasher,
    throttle: createLoginThrottle(pool, undefined, csrfSecret),
    devices: createDeviceService(pool, undefined, csrfSecret),
  });
  await app.ready();
});

beforeEach(async () => {
  await clearTables(pool);
  calls.verify = 0;
  calls.dummy = 0;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

async function loginForm(): Promise<{ cookie: string; token: string }> {
  const response = await app.inject({ method: "GET", url: "/login" });
  const cookie = response.cookies.find((c) => c.name === "__Host-csrf");
  const token = /name="_csrf" value="([^"]+)"/.exec(response.body)?.[1];
  expect(cookie).toBeDefined();
  expect(token).toBeDefined();
  return { cookie: `__Host-csrf=${cookie?.value}`, token: token ?? "" };
}

async function login(email: string, password: string, withToken = true) {
  const { cookie, token } = await loginForm();
  const fields = new URLSearchParams({ email, password });
  if (withToken) fields.set("_csrf", token);
  return app.inject({
    method: "POST",
    url: "/login",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    payload: fields.toString(),
  });
}

describe("POST /login", () => {
  it("con credenciales correctas crea la sesión y redirige al panel del rol", async () => {
    const roles = [
      ["patient", "/pacientes/panel"],
      ["doctor", "/medicos/inicio"],
      ["reception", "/recepcion/panel"],
      ["support", "/soporte/medicos"],
    ] as const;
    for (const [role, destino] of roles) {
      const user = await createUser(pool, { role });
      const response = await login(user.email, user.password);
      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toBe(destino);

      const cookie = response.cookies.find((c) => c.name === SESSION_COOKIE);
      expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", path: "/" });
      expect(await sessions.validate(cookie?.value ?? "")).toMatchObject({ userId: user.id, role });
    }
  });

  it("normaliza el correo (mayúsculas y espacios)", async () => {
    const user = await createUser(pool);
    const response = await login(`  ${user.email.toUpperCase()} `, user.password);
    expect(response.statusCode).toBe(303);
  });

  it("correo inexistente y contraseña incorrecta dan exactamente la misma respuesta", async () => {
    const user = await createUser(pool);
    const wrongPassword = await login(user.email, "otra-contraseña-incorrecta");
    const unknownEmail = await login("nadie@example.com", "otra-contraseña-incorrecta");

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    const normalizar = (body: string) => body.replace(/name="_csrf" value="[^"]+"/, "").replace(/value="[^"]*"/g, "");
    expect(normalizar(wrongPassword.body)).toBe(normalizar(unknownEmail.body));
    expect(wrongPassword.body).toContain("Correo o contraseña incorrectos");
    expect(wrongPassword.cookies.find((c) => c.name === SESSION_COOKIE)).toBeUndefined();
    expect(unknownEmail.cookies.find((c) => c.name === SESSION_COOKIE)).toBeUndefined();
  });

  it("hace el mismo trabajo de hash con un correo inexistente (hash ficticio) que con uno real", async () => {
    const user = await createUser(pool);
    await login(user.email, "otra-contraseña-incorrecta");
    expect(calls).toEqual({ verify: 1, dummy: 0 });

    calls.verify = 0;
    await login("nadie@example.com", "otra-contraseña-incorrecta");
    expect(calls).toEqual({ verify: 0, dummy: 1 });
  });

  it("una cuenta deshabilitada no entra y recibe el mismo mensaje", async () => {
    const user = await createUser(pool, { status: "disabled" });
    const response = await login(user.email, user.password);
    expect(response.statusCode).toBe(401);
    expect(response.body).toContain("Correo o contraseña incorrectos");
    expect(response.cookies.find((c) => c.name === SESSION_COOKIE)).toBeUndefined();
  });

  it("actualiza el hash si usa un algoritmo o parámetros más débiles que la configuración", async () => {
    const user = await createUser(pool); // la fábrica usa bcrypt de costo bajo
    await login(user.email, user.password);
    const [rows] = await pool.query<RowDataPacket[]>("SELECT password_hash FROM `user` WHERE id = ?", [user.id]);
    expect(String(rows[0]?.password_hash)).toMatch(/^\$argon2id\$/);
    // La contraseña sigue funcionando con el hash nuevo.
    expect((await login(user.email, user.password)).statusCode).toBe(303);
  });

  it("rechaza el envío sin token CSRF", async () => {
    const user = await createUser(pool);
    const response = await login(user.email, user.password, false);
    expect(response.statusCode).toBe(403);
  });

  it("devuelve 400 con campos faltantes y no crea sesión", async () => {
    const { cookie, token } = await loginForm();
    const response = await app.inject({
      method: "POST",
      url: "/login",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ _csrf: token }).toString(),
    });
    expect(response.statusCode).toBe(400);
  });

  it("si el usuario tiene doble factor, la sesión queda a medias y va a /login/mfa", async () => {
    const user = await createUser(pool);
    await pool.execute("UPDATE `user` SET mfa_enabled = 1 WHERE id = ?", [user.id]);
    const response = await login(user.email, user.password);
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/login/mfa");
    const cookie = response.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(await sessions.validate(cookie?.value ?? "")).toMatchObject({ mfaEnabled: true, mfaVerified: false });
  });
});

describe("POST /logout", () => {
  it("revoca la sesión y limpia la cookie", async () => {
    const user = await createUser(pool);
    const loggedIn = await login(user.email, user.password);
    const sessionCookie = loggedIn.cookies.find((c) => c.name === SESSION_COOKIE);
    const cookieHeader = `${SESSION_COOKIE}=${sessionCookie?.value}`;

    const form = await app.inject({ method: "GET", url: "/login", headers: { cookie: cookieHeader } });
    // Con sesión activa, GET /login redirige al panel; el token CSRF de sesión se obtiene de la sesión.
    expect(form.statusCode).toBe(303);

    const session = await sessions.validate(sessionCookie?.value ?? "");
    const { createHmac } = await import("node:crypto");
    const csrf = createHmac("sha256", csrfSecret).update(`s:${session?.csrfSecret}`).digest("base64url");

    const response = await app.inject({
      method: "POST",
      url: "/logout",
      headers: { cookie: cookieHeader, "x-csrf-token": csrf },
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/login");
    expect(await sessions.validate(sessionCookie?.value ?? "")).toBeNull();
    expect(response.cookies.find((c) => c.name === SESSION_COOKIE)?.value).toBe("");
  });

  it("exige token CSRF", async () => {
    const user = await createUser(pool);
    const loggedIn = await login(user.email, user.password);
    const sessionCookie = loggedIn.cookies.find((c) => c.name === SESSION_COOKIE);
    const response = await app.inject({
      method: "POST",
      url: "/logout",
      headers: { cookie: `${SESSION_COOKIE}=${sessionCookie?.value}` },
    });
    expect(response.statusCode).toBe(403);
    expect(await sessions.validate(sessionCookie?.value ?? "")).not.toBeNull();
  });
});
