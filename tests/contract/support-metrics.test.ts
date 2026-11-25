import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTables, createTestPool, createUser, ensurePrivacyDocument, resetDatabase } from "../integration/helpers/db.js";
import { createSupportWithMfa, createTestApp, sessionFor, uniqueIp, type AuthedClient, type TestApp } from "../integration/helpers/app.js";

const pool = createTestPool();
let t: TestApp;
let support: AuthedClient;

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  await ensurePrivacyDocument(pool);
  support = await sessionFor(t.services, await createSupportWithMfa(t, pool));
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

const get = (url: string, client: AuthedClient | null, accept = "text/html") =>
  t.app.inject({ method: "GET", url, remoteAddress: uniqueIp(), headers: { ...(client ? { cookie: client.cookie } : {}), accept } });

describe("GET /soporte/metricas", () => {
  it("acepta los tres periodos y por omisión usa las últimas 4 semanas", async () => {
    for (const periodo of ["semana", "4semanas", "piloto"]) {
      const response = await get(`/soporte/metricas?periodo=${periodo}`, support, "application/json");
      expect(response.statusCode, periodo).toBe(200);
      expect((response.json() as { period: string }).period).toBe(periodo);
    }
    expect(((await get("/soporte/metricas", support, "application/json")).json() as { period: string }).period).toBe("4semanas");
  });

  it("un periodo inválido responde 400", async () => {
    expect((await get("/soporte/metricas?periodo=siempre", support)).statusCode).toBe(400);
  });

  it("el JSON trae las claves del contrato y metas; sin datos no hay ceros engañosos", async () => {
    const json = (await get("/soporte/metricas", support, "application/json")).json() as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual(
      ["activeDoctorsPerWeek", "appointmentsPerDoctorWeek", "booking", "from", "mail", "period", "sustainedUse", "targets", "to", "urgent", "urgentAbuse"].sort(),
    );
    expect(json.targets).toEqual({ completionPercent: 70, bookingSeconds: 120, deliveredPercent: 98, sustainedUsePercent: 50 });
    expect((json.booking as { completionPercent: number | null }).completionPercent).toBeNull();
  });

  it("el HTML muestra «sin datos» y las metas", async () => {
    const body = (await get("/soporte/metricas", support)).body;
    expect(body).toContain("sin datos");
    expect(body).toContain("más de 70 %");
    expect(body).toContain("más de 98 %");
  });

  it("solo soporte con el doble factor: sin sesión 401, otros roles 403", async () => {
    expect((await get("/soporte/metricas", null, "application/json")).statusCode).toBe(401);
    for (const role of ["doctor", "reception", "patient"] as const) {
      const client = await sessionFor(t.services, await createUser(pool, { role }));
      expect((await get("/soporte/metricas", client, "application/json")).statusCode, role).toBe(403);
    }
  });
});
