import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appendSupportAction, PAGE_SIZE } from "../../src/modules/support/action-log.js";
import { clearTables, createDoctor, createTestPool, createUser, ensurePrivacyDocument, resetDatabase } from "../integration/helpers/db.js";
import { createSupportWithMfa, createTestApp, JPEG, postForm, sessionFor, uniqueIp, type AuthedClient, type TestApp } from "../integration/helpers/app.js";

const pool = createTestPool();
let t: TestApp;
let supportA: AuthedClient;
let supportAId: number;
let supportBId: number;

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool, {}, {
    onRoute: (route) => {
      for (const method of Array.isArray(route.method) ? route.method : [route.method]) registered.push({ method, url: route.url });
    },
  });
});

const registered: { method: string; url: string }[] = [];

beforeEach(async () => {
  await clearTables(pool);
  await ensurePrivacyDocument(pool);
  const a = await createSupportWithMfa(t, pool);
  supportAId = a.id;
  supportA = await sessionFor(t.services, a);
  supportBId = (await createUser(pool, { role: "support", email: "segunda.persona@example.com" })).id;
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

const get = (url: string, client: AuthedClient | null = supportA, accept = "text/html") =>
  t.app.inject({ method: "GET", url, remoteAddress: uniqueIp(), headers: { ...(client ? { cookie: client.cookie } : {}), accept } });

const add = (supportUserId: number, action: Parameters<typeof appendSupportAction>[1]["action"], at: string, reason: string | null, targetId = 1) =>
  appendSupportAction(pool, { supportUserId, action, targetType: "doctor", targetId, reason, occurredAt: new Date(at) });

describe("GET /soporte/historial", () => {
  it("lista las acciones de dos personas con autor y motivo, más recientes primero", async () => {
    await add(supportAId, "suspend", "2026-11-20T10:00:00.000Z", "cuenta duplicada");
    await add(supportBId, "reactivate", "2026-11-21T10:00:00.000Z", "ya se aclaró");
    const html = await get("/soporte/historial");
    expect(html.statusCode).toBe(200);
    expect(html.body.indexOf("ya se aclaró")).toBeLessThan(html.body.indexOf("cuenta duplicada"));
    expect(html.body).toContain("segunda.persona@example.com");
    const json = (await get("/soporte/historial", supportA, "application/json")).json() as { rows: Array<{ action: string; reason: string | null }>; hasNext: boolean };
    expect(json.rows.map((row) => row.action)).toEqual(["reactivate", "suspend"]);
    expect(json.hasNext).toBe(false);
  });

  it("filtra por persona, acción, objetivo y fechas, y rechaza filtros inválidos", async () => {
    await add(supportAId, "suspend", "2026-11-01T10:00:00.000Z", "a", 1);
    await add(supportBId, "suspend", "2026-11-05T10:00:00.000Z", "b", 2);
    await add(supportBId, "reactivate", "2026-11-10T10:00:00.000Z", "c", 2);
    const reasons = async (query: string) => ((await get(`/soporte/historial?${query}`, supportA, "application/json")).json() as { rows: Array<{ reason: string }> }).rows.map((row) => row.reason);
    expect(await reasons(`persona=${supportBId}`)).toEqual(["c", "b"]);
    expect(await reasons("accion=reactivate")).toEqual(["c"]);
    expect(await reasons("objetivo=1")).toEqual(["a"]);
    expect(await reasons("desde=2026-11-02&hasta=2026-11-06")).toEqual(["b"]);
    for (const bad of ["accion=borrar", "desde=2026-11-10&hasta=2026-11-01", "pagina=0", "persona=abc", "desde=ayer"]) {
      expect((await get(`/soporte/historial?${bad}`)).statusCode, bad).toBe(400);
    }
  });

  it("pagina de 50 en 50 y los enlaces conservan los filtros", async () => {
    for (let index = 0; index < PAGE_SIZE + 3; index += 1) {
      await add(supportAId, "view_cedula", new Date(Date.UTC(2026, 10, 1, 0, 0, index)).toISOString(), null);
    }
    const first = (await get("/soporte/historial?accion=view_cedula", supportA, "application/json")).json() as { rows: unknown[]; hasNext: boolean };
    expect(first.rows).toHaveLength(PAGE_SIZE);
    expect(first.hasNext).toBe(true);
    const html = await get("/soporte/historial?accion=view_cedula");
    expect(html.body).toContain("accion=view_cedula");
    expect(html.body).toContain("pagina=2");
    expect(((await get("/soporte/historial?accion=view_cedula&pagina=2", supportA, "application/json")).json() as { rows: unknown[] }).rows).toHaveLength(3);
  });

  it("solo soporte: sin sesión 401, otros roles 403", async () => {
    expect((await get("/soporte/historial", null, "application/json")).statusCode).toBe(401);
    for (const role of ["doctor", "reception", "patient"] as const) {
      const client = await sessionFor(t.services, await createUser(pool, { role }));
      expect((await get("/soporte/historial", client, "application/json")).statusCode, role).toBe(403);
    }
  });
});

describe("consultar la cédula deja registro", () => {
  it("registra view_cedula con persona y fecha, sin motivo ni contenido; un 404 no registra nada", async () => {
    const stored = await t.services.cedulaStorage.save(JPEG);
    const doctor = await createDoctor(pool, { status: "pending", cedulaFileName: stored.name });
    const response = await get(`/soporte/medicos/${doctor.doctorId}/cedula`);
    expect(response.statusCode).toBe(200);
    expect(await rows("SELECT support_user_id, action, target_type, target_id, reason FROM support_action_log")).toEqual([
      { support_user_id: supportAId, action: "view_cedula", target_type: "doctor", target_id: doctor.doctorId, reason: null },
    ]);

    const without = await createDoctor(pool, { status: "pending" });
    expect((await get(`/soporte/medicos/${without.doctorId}/cedula`)).statusCode).toBe(404);
    expect((await get("/soporte/medicos/999999/cedula")).statusCode).toBe(404);
    expect(await rows("SELECT id FROM support_action_log")).toHaveLength(1);
  });

  it("si el registro falla no se entrega el archivo", async () => {
    const stored = await t.services.cedulaStorage.save(JPEG);
    const doctor = await createDoctor(pool, { status: "pending", cedulaFileName: stored.name });
    // Un disparador temporal hace fallar cualquier alta en el historial.
    await pool.query("CREATE TRIGGER support_log_test_fail BEFORE INSERT ON support_action_log FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'fallo de prueba'");
    try {
      const response = await get(`/soporte/medicos/${doctor.doctorId}/cedula`);
      expect(response.statusCode).toBe(500);
      expect(response.rawPayload.equals(JPEG)).toBe(false);
    } finally {
      await pool.query("DROP TRIGGER support_log_test_fail");
    }
    expect(await rows("SELECT id FROM support_action_log")).toEqual([]);
  });
});

describe("el historial no se puede modificar", () => {
  it("no hay rutas PUT, PATCH ni DELETE bajo /soporte, ni POST sobre el historial", () => {
    const support = registered.filter((route) => route.url.startsWith("/soporte"));
    expect(support.length).toBeGreaterThan(10);
    expect(support.filter((route) => !["GET", "HEAD", "POST"].includes(route.method))).toEqual([]);
    expect(support.filter((route) => route.url.startsWith("/soporte/historial") && route.method === "POST")).toEqual([]);
  });

  it("un POST al historial no existe (404) y ni UPDATE ni DELETE directos funcionan", async () => {
    await add(supportAId, "approve", "2026-11-01T10:00:00.000Z", null);
    const response = await postForm(t.app, "/soporte/historial", { _csrf: supportA.csrf }, supportA.cookie);
    expect(response.statusCode).toBe(404);
    await expect(pool.execute("UPDATE support_action_log SET reason = 'x'")).rejects.toThrow();
    await expect(pool.execute("DELETE FROM support_action_log")).rejects.toThrow();
  });
});
