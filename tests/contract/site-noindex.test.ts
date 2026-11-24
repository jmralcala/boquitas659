import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestPool, resetDatabase } from "../integration/helpers/db.js";
import { createTestApp, uniqueIp, type TestApp } from "../integration/helpers/app.js";

const pool = createTestPool();
let t: TestApp;

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

function get(url: string) {
  return t.app.inject({ method: "GET", url, remoteAddress: uniqueIp(), headers: { accept: "text/html" } });
}

describe("noindex en el micrositio y las pantallas del paciente", () => {
  it.each(["/c/no-existe", "/c/no-existe/logo", "/c/no-existe/entrar", "/citas/enlace/" + "a".repeat(43), "/pacientes/registro", "/pacientes/citas"])(
    "%s lleva la cabecera X-Robots-Tag, incluso en las respuestas de error",
    async (url) => {
      const response = await get(url);
      expect(response.headers["x-robots-tag"], `${url} → ${response.statusCode}`).toBe("noindex, nofollow");
    },
  );

  it("una ruta que no es del micrositio no la lleva", async () => {
    const response = await get("/login");
    expect(response.headers["x-robots-tag"]).toBeUndefined();
  });

  it("las páginas HTML llevan además la meta noindex", async () => {
    const response = await get("/pacientes/registro");
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('name="robots" content="noindex"');
  });
});
