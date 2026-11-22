import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/http/app.js";
import { SESSION_COOKIE } from "../../src/http/session-plugin.js";
import { createSessionService } from "../../src/modules/auth/sessions.js";
import { clearTables, createTestPool, createUser, resetDatabase } from "../integration/helpers/db.js";

const pool = createTestPool();
const sessions = createSessionService(pool);
const csrfSecret = "s".repeat(40);

let app: FastifyInstance;
let efectos = 0;

beforeAll(async () => {
  await resetDatabase(pool);
  app = await buildApp({ appEnv: "development", sessions, csrfSecret });
  app.get("/formulario", async (request, reply) => ({ token: app.csrf.tokenFor(request, reply) }));
  app.get("/lectura", async () => ({ efectos }));
  app.post("/accion", async () => {
    efectos += 1;
    return { ok: true };
  });
  await app.ready();
});

beforeEach(async () => {
  await clearTables(pool);
  efectos = 0;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

async function sesionDe(role: "patient" | "doctor" = "patient"): Promise<{ cookie: string; token: string }> {
  const user = await createUser(pool, { role });
  const { token } = await sessions.create(user.id);
  const cookie = `${SESSION_COOKIE}=${token}`;
  const response = await app.inject({ method: "GET", url: "/formulario", headers: { cookie } });
  return { cookie, token: response.json().token };
}

describe("CSRF con sesión", () => {
  it("rechaza un POST sin token", async () => {
    const { cookie } = await sesionDe();
    const response = await app.inject({ method: "POST", url: "/accion", headers: { cookie, accept: "application/json" } });
    expect(response.statusCode).toBe(403);
    expect(efectos).toBe(0);
  });

  it("rechaza el token de otra sesión", async () => {
    const a = await sesionDe();
    const b = await sesionDe("doctor");
    const response = await app.inject({
      method: "POST",
      url: "/accion",
      headers: { cookie: a.cookie, accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      payload: `_csrf=${b.token}`,
    });
    expect(response.statusCode).toBe(403);
    expect(efectos).toBe(0);
  });

  it("acepta el token propio enviado como campo de formulario", async () => {
    const { cookie, token } = await sesionDe();
    const response = await app.inject({
      method: "POST",
      url: "/accion",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: `_csrf=${token}`,
    });
    expect(response.statusCode).toBe(200);
    expect(efectos).toBe(1);
  });

  it("acepta el token propio enviado en la cabecera x-csrf-token", async () => {
    const { cookie, token } = await sesionDe();
    const response = await app.inject({
      method: "POST",
      url: "/accion",
      headers: { cookie, "x-csrf-token": token },
    });
    expect(response.statusCode).toBe(200);
  });

  it("GET nunca exige token ni cambia estado", async () => {
    const { cookie } = await sesionDe();
    const response = await app.inject({ method: "GET", url: "/lectura", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(efectos).toBe(0);
  });
});

describe("CSRF sin sesión (doble envío firmado)", () => {
  async function formularioAnonimo(): Promise<{ cookie: string; token: string }> {
    const response = await app.inject({ method: "GET", url: "/formulario" });
    const setCookie = response.cookies.find((c) => c.name === "__Host-csrf");
    expect(setCookie).toBeDefined();
    expect(setCookie?.httpOnly).toBe(true);
    expect(setCookie?.secure).toBe(true);
    return { cookie: `__Host-csrf=${setCookie?.value}`, token: response.json().token };
  }

  it("acepta cookie y token coincidentes", async () => {
    const { cookie, token } = await formularioAnonimo();
    const response = await app.inject({ method: "POST", url: "/accion", headers: { cookie, "x-csrf-token": token } });
    expect(response.statusCode).toBe(200);
  });

  it("rechaza el token sin la cookie", async () => {
    const { token } = await formularioAnonimo();
    const response = await app.inject({ method: "POST", url: "/accion", headers: { "x-csrf-token": token } });
    expect(response.statusCode).toBe(403);
  });

  it("rechaza el token de otra cookie", async () => {
    const a = await formularioAnonimo();
    const b = await formularioAnonimo();
    const response = await app.inject({
      method: "POST",
      url: "/accion",
      headers: { cookie: a.cookie, "x-csrf-token": b.token },
    });
    expect(response.statusCode).toBe(403);
  });

  it("rechaza un token inventado", async () => {
    const { cookie } = await formularioAnonimo();
    const response = await app.inject({ method: "POST", url: "/accion", headers: { cookie, "x-csrf-token": "inventado" } });
    expect(response.statusCode).toBe(403);
  });
});
