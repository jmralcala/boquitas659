import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "../../src/compose.js";
import { loadEnv } from "../../src/config/env.js";
import { createTestPool, resetDatabase, testDatabaseUrl } from "./helpers/db.js";

const pool = createTestPool();
let server: Server;

beforeAll(async () => {
  await resetDatabase(pool);
  server = await createServer(
    loadEnv({
      APP_ENV: "development",
      PUBLIC_BASE_URL: "http://localhost:3000",
      DATABASE_URL: testDatabaseUrl(),
      SESSION_SECRET: "s".repeat(40),
      MFA_ENCRYPTION_KEY: "b".repeat(64),
      CEDULA_STORAGE_DIR: "./storage/cedulas-test",
    }),
  );
  await server.app.ready();
});

afterAll(async () => {
  await server.close();
  await pool.end();
});

describe("servidor compuesto", () => {
  it("en desarrollo registra las rutas de soporte", async () => {
    const response = await server.app.inject({ method: "GET", url: "/soporte/medicos", headers: { accept: "application/json" } });
    expect(response.statusCode).toBe(401); // existe, pero exige sesión de soporte
  });

  it("sirve el formulario de login con cabeceras de seguridad", async () => {
    const response = await server.app.inject({ method: "GET", url: "/login" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Iniciar sesión");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("devuelve 404 genérico en rutas inexistentes", async () => {
    const response = await server.app.inject({ method: "GET", url: "/no-existe" });
    expect(response.statusCode).toBe(404);
  });

  it("siembra los 5 textos legales provisionales al arrancar", async () => {
    const [rows] = await pool.query("SELECT COUNT(*) AS n FROM legal_document WHERE is_provisional = 1");
    expect(Number((rows as { n: number }[])[0]?.n)).toBe(5);
  });
});

describe("servidor en producción", () => {
  it("registra las rutas de soporte, que exigen sesión de soporte con doble factor", async () => {
    const productionServer = await createServer(
      loadEnv({
        APP_ENV: "production",
        PUBLIC_BASE_URL: "https://agenda.example.com",
        DATABASE_URL: testDatabaseUrl(),
        SESSION_SECRET: "s".repeat(40),
        MFA_ENCRYPTION_KEY: "b".repeat(64),
        CEDULA_STORAGE_DIR: "./storage/cedulas-test",
        SMTP_HOST: "smtp.example.com",
        SMTP_PORT: "587",
        SMTP_USER: "usuario",
        SMTP_PASS: "clave-de-prueba",
        SMTP_FROM: "no-responder@example.com",
      }),
    );
    try {
      for (const url of ["/soporte/medicos", "/soporte/medicos/1", "/soporte/medicos/1/cedula"]) {
        const response = await productionServer.app.inject({ method: "GET", url, headers: { accept: "application/json" } });
        expect(response.statusCode, url).toBe(401); // existen, pero sin sesión no se entra
      }
      // Sin sesión ni token CSRF no se puede aprobar nada.
      const post = await productionServer.app.inject({ method: "POST", url: "/soporte/medicos/1/aprobar" });
      expect(post.statusCode).toBe(403);
    } finally {
      await productionServer.close();
    }
  });
});
