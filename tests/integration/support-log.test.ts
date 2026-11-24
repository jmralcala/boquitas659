import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appendSupportAction, historyFilters, listSupportActions, PAGE_SIZE, type SupportAction } from "../../src/modules/support/action-log.js";
import { clearTables, createTestPool, createUser, resetDatabase } from "./helpers/db.js";

const pool = createTestPool();

beforeAll(async () => {
  await resetDatabase(pool);
});

beforeEach(async () => {
  await clearTables(pool);
});

afterAll(async () => {
  await pool.end();
});

async function add(supportUserId: number, action: SupportAction, at: string, reason: string | null = "motivo", targetId = 1): Promise<void> {
  await appendSupportAction(pool, { supportUserId, action, targetType: "doctor", targetId, reason, occurredAt: new Date(at) });
}

const filters = (query: Record<string, string> = {}) => historyFilters.parse(query);

describe("historial de acciones de soporte", () => {
  it("registra persona, acción, objetivo, motivo y fecha", async () => {
    const support = await createUser(pool, { role: "support", email: "soporte.uno@example.com" });
    await add(support.id, "suspend", "2026-11-20T10:00:00.000Z", "cuenta duplicada", 7);
    const page = await listSupportActions(pool, filters());
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({
      supportUserId: support.id,
      supportEmail: "soporte.uno@example.com",
      action: "suspend",
      targetType: "doctor",
      targetId: 7,
      reason: "cuenta duplicada",
    });
    expect(page.rows[0]?.occurredAt.toISOString()).toBe("2026-11-20T10:00:00.000Z");
  });

  it("lista de la más reciente a la más antigua", async () => {
    const support = await createUser(pool, { role: "support" });
    await add(support.id, "approve", "2026-11-01T10:00:00.000Z");
    await add(support.id, "suspend", "2026-11-03T10:00:00.000Z");
    await add(support.id, "reactivate", "2026-11-02T10:00:00.000Z");
    const actions = (await listSupportActions(pool, filters())).rows.map((row) => row.action);
    expect(actions).toEqual(["suspend", "reactivate", "approve"]);
  });

  it("pagina de 50 en 50 e indica si hay más", async () => {
    const support = await createUser(pool, { role: "support" });
    for (let index = 0; index < PAGE_SIZE + 5; index += 1) {
      await add(support.id, "view_cedula", new Date(Date.UTC(2026, 10, 1, 0, 0, index)).toISOString(), null);
    }
    const first = await listSupportActions(pool, filters());
    expect(first.rows).toHaveLength(PAGE_SIZE);
    expect(first.hasNext).toBe(true);
    const second = await listSupportActions(pool, filters({ pagina: "2" }));
    expect(second.rows).toHaveLength(5);
    expect(second.hasNext).toBe(false);
  });

  it("filtra por persona, acción, objetivo y rango de fechas", async () => {
    const one = await createUser(pool, { role: "support" });
    const two = await createUser(pool, { role: "support" });
    await add(one.id, "suspend", "2026-11-01T10:00:00.000Z", "a", 1);
    await add(two.id, "suspend", "2026-11-05T10:00:00.000Z", "b", 2);
    await add(two.id, "reactivate", "2026-11-10T23:59:59.000Z", "c", 2);

    expect((await listSupportActions(pool, filters({ persona: String(two.id) }))).rows).toHaveLength(2);
    expect((await listSupportActions(pool, filters({ accion: "suspend" }))).rows).toHaveLength(2);
    expect((await listSupportActions(pool, filters({ objetivo: "2" }))).rows).toHaveLength(2);
    expect((await listSupportActions(pool, filters({ desde: "2026-11-02", hasta: "2026-11-10" }))).rows.map((row) => row.reason)).toEqual(["c", "b"]);
    expect((await listSupportActions(pool, filters({ desde: "2026-11-11" }))).rows).toEqual([]);
  });

  it("«desde» posterior a «hasta», fechas mal escritas y acciones desconocidas son errores de validación", () => {
    expect(historyFilters.safeParse({ desde: "2026-11-10", hasta: "2026-11-01" }).success).toBe(false);
    expect(historyFilters.safeParse({ desde: "10/11/2026" }).success).toBe(false);
    expect(historyFilters.safeParse({ accion: "borrar" }).success).toBe(false);
    expect(historyFilters.safeParse({ pagina: "0" }).success).toBe(false);
  });

  it("no existe forma de modificar ni borrar una entrada", async () => {
    const support = await createUser(pool, { role: "support" });
    await add(support.id, "approve", "2026-11-01T10:00:00.000Z");
    await expect(pool.execute("UPDATE support_action_log SET reason = 'cambiado'")).rejects.toThrow();
    await expect(pool.execute("DELETE FROM support_action_log")).rejects.toThrow();
    expect((await listSupportActions(pool, filters())).rows[0]?.reason).toBe("motivo");
  });
});

describe("filtro por objetivo", () => {
  it("la cuenta de un médico incluye su ficha y su micrositio, pero no un correo con el mismo id", async () => {
    const support = await createUser(pool, { role: "support" });
    await appendSupportAction(pool, { supportUserId: support.id, action: "suspend", targetType: "doctor", targetId: 5, reason: "doctor", occurredAt: new Date("2026-11-01T10:00:00.000Z") });
    await appendSupportAction(pool, { supportUserId: support.id, action: "change_slug", targetType: "site", targetId: 5, reason: "site", occurredAt: new Date("2026-11-02T10:00:00.000Z") });
    await appendSupportAction(pool, { supportUserId: support.id, action: "retry_email", targetType: "email", targetId: 5, reason: "email", occurredAt: new Date("2026-11-03T10:00:00.000Z") });
    const page = await listSupportActions(pool, historyFilters.parse({ objetivo: "5" }));
    expect(page.rows.map((row) => row.reason)).toEqual(["site", "doctor"]);
  });

  it("rechaza fechas que no existen en el calendario", () => {
    expect(historyFilters.safeParse({ desde: "2026-02-31" }).success).toBe(false);
    expect(historyFilters.safeParse({ hasta: "2026-13-01" }).success).toBe(false);
    expect(historyFilters.safeParse({ desde: "2026-02-28" }).success).toBe(true);
  });
});
