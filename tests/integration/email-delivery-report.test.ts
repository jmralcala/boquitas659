import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deliveryReport } from "../../src/mail/delivery-report.js";
import { clearTables, createTestPool, resetDatabase } from "./helpers/db.js";

const pool = createTestPool();
const DAY = 86_400_000;
const NOW = new Date("2026-06-15T12:00:00.000Z");
const range = { from: new Date(NOW.getTime() - 30 * DAY), to: NOW };

beforeAll(async () => {
  await resetDatabase(pool);
});

beforeEach(async () => {
  await clearTables(pool);
});

afterAll(async () => {
  await pool.end();
});

async function add(template: string, status: "queued" | "sent" | "failed" | "cancelled", count: number, daysAgo = 1): Promise<void> {
  const createdAt = new Date(NOW.getTime() - daysAgo * DAY);
  for (let i = 0; i < count; i += 1) {
    await pool.execute(
      "INSERT INTO email_outbox (template, to_email, payload_ref, status, next_attempt_at, created_at) VALUES (?, 'persona.privada@example.com', '{}', ?, ?, ?)",
      [template, status, createdAt, createdAt],
    );
  }
}

describe("deliveryReport (SC-010)", () => {
  it("calcula entregados sobre resueltos y no cuenta los pendientes como fallos", async () => {
    await add("password_reset", "sent", 97);
    await add("password_reset", "failed", 1);
    await add("password_reset", "queued", 20);
    const report = await deliveryReport(pool, range);
    expect(report).toMatchObject({ sent: 97, failed: 1, queued: 20, deliveredPercent: 99 });
    expect(report.meetsTarget).toBe(true);
  });

  it("la meta es MÁS de 98 %: exactamente 98 % no la cumple", async () => {
    await add("a", "sent", 98);
    await add("a", "failed", 2);
    const report = await deliveryReport(pool, range);
    expect(report.deliveredPercent).toBe(98);
    expect(report.meetsTarget).toBe(false);
  });

  it("desglosa por plantilla", async () => {
    await add("password_reset", "sent", 3);
    await add("new_device_login", "sent", 2);
    await add("new_device_login", "failed", 1);
    const report = await deliveryReport(pool, range);
    expect(report.byTemplate).toEqual([
      { template: "new_device_login", sent: 2, failed: 1, queued: 0, cancelled: 0 },
      { template: "password_reset", sent: 3, failed: 0, queued: 0, cancelled: 0 },
    ]);
  });

  it("los correos cancelados no cuentan como fallos de entrega", async () => {
    await add("a", "sent", 99);
    await add("a", "failed", 1);
    await add("a", "cancelled", 50);
    const report = await deliveryReport(pool, range);
    expect(report).toMatchObject({ sent: 99, failed: 1, cancelled: 50, deliveredPercent: 99 });
  });

  it("solo cuenta el periodo pedido", async () => {
    await add("a", "sent", 5, 2);
    await add("a", "failed", 5, 60); // fuera del periodo
    const report = await deliveryReport(pool, range);
    expect(report).toMatchObject({ sent: 5, failed: 0, deliveredPercent: 100 });
  });

  it("sin correos resueltos no hay porcentaje ni veredicto", async () => {
    await add("a", "queued", 4);
    const report = await deliveryReport(pool, range);
    expect(report.deliveredPercent).toBeNull();
    expect(report.meetsTarget).toBeNull();
    expect((await deliveryReport(pool, { from: new Date(0), to: new Date(1000) })).sent).toBe(0);
  });

  it("el informe no incluye direcciones ni contenido", async () => {
    await add("password_reset", "sent", 2);
    const dump = JSON.stringify(await deliveryReport(pool, range));
    expect(dump).not.toContain("persona.privada");
    expect(dump).not.toContain("@");
  });
});
