import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFixedClock, type FixedClock } from "../../src/lib/clock.js";
import { enqueueEmail, processOutbox, type OutboxDeps, type OutboxLogEvent } from "../../src/mail/outbox.js";
import type { TemplateRegistry } from "../../src/mail/templates.js";
import { createMemoryTransport, type MemoryTransport } from "../../src/mail/transport.js";
import { createOneTimeTokenService } from "../../src/modules/auth/one-time-tokens.js";
import { clearTables, createTestPool, resetDatabase } from "./helpers/db.js";

// Claves sensibles del payload (feature 4: la categoría de una urgencia vive solo en la cola de envío).
const pool = createTestPool();
const HOUR = 3_600_000;
const SECRET = "categoria-reconocible";

const templates: TemplateRegistry = {
  sensible: {
    sensitiveKeys: ["category"],
    fallbackTemplate: "generica",
    render: () => ({ subject: "Aviso", text: "Cuerpo" }),
  },
  sensible_sin_respaldo: {
    sensitiveKeys: ["category"],
    render: () => ({ subject: "Aviso", text: "Cuerpo" }),
  },
  sensible_cancelable: {
    sensitiveKeys: ["category"],
    fallbackTemplate: "generica",
    shouldSend: () => Promise.resolve(false),
    render: () => ({ subject: "Aviso", text: "Cuerpo" }),
  },
  generica: {
    render: () => ({ subject: "Genérico", text: "Revisa tu agenda" }),
  },
  normal: {
    render: () => ({ subject: "Normal", text: "Cuerpo" }),
  },
};

let clock: FixedClock;
let transport: MemoryTransport;
let events: OutboxLogEvent[];
let deps: OutboxDeps;

beforeAll(async () => {
  await resetDatabase(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  clock = createFixedClock(new Date("2026-06-01T10:00:00.000Z"));
  transport = createMemoryTransport();
  events = [];
  deps = {
    db: pool,
    transport,
    tokens: createOneTimeTokenService(pool, clock),
    templates,
    baseUrl: "https://agenda.example.com",
    clock,
    maxAttempts: 3,
    log: (event) => events.push(event),
  };
});

afterAll(async () => {
  await pool.end();
});

async function outbox(): Promise<RowDataPacket[]> {
  const [rows] = await pool.query<RowDataPacket[]>("SELECT id, template, to_email, status, attempts, payload_ref FROM email_outbox ORDER BY id");
  return rows;
}

const payloadOf = (row: RowDataPacket | undefined): Record<string, unknown> => JSON.parse(String(row?.payload_ref)) as Record<string, unknown>;

const enqueueSensitive = (template = "sensible") => enqueueEmail(pool, { template, to: "medico@example.com", payload: { appointmentId: 7, category: SECRET } }, clock);

describe("claves sensibles del payload", () => {
  it("mientras el correo está en cola la clave sigue presente", async () => {
    await enqueueSensitive();
    expect(payloadOf((await outbox())[0])).toEqual({ appointmentId: 7, category: SECRET });
  });

  it("se elimina en la misma operación que marca el envío", async () => {
    await enqueueSensitive();
    await processOutbox(deps);
    const [row] = await outbox();
    expect(row?.status).toBe("sent");
    expect(payloadOf(row)).toEqual({ appointmentId: 7 });
    expect(String(row?.payload_ref)).not.toContain(SECRET);
    expect(transport.sent).toHaveLength(1);
  });

  it("se elimina al cancelarse el correo (shouldSend falso) y no se encola el respaldo", async () => {
    await enqueueSensitive("sensible_cancelable");
    const result = await processOutbox(deps);
    expect(result.cancelled).toBe(1);
    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("cancelled");
    expect(payloadOf(rows[0])).toEqual({ appointmentId: 7 });
    expect(transport.sent).toEqual([]);
  });

  it("un reintento intermedio NO la elimina (el correo sigue pendiente)", async () => {
    await enqueueSensitive();
    transport.failNext(1);
    const result = await processOutbox(deps);
    expect(result.retried).toBe(1);
    const [row] = await outbox();
    expect(row?.status).toBe("queued");
    expect(payloadOf(row)).toEqual({ appointmentId: 7, category: SECRET });
  });

  it("al agotar los reintentos se elimina y se encola la plantilla de respaldo sin la clave", async () => {
    await enqueueSensitive();
    transport.failNext(10);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await processOutbox(deps);
      clock.advance(2 * HOUR);
    }
    const rows = await outbox();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ template: "sensible", status: "failed", attempts: 3 });
    expect(payloadOf(rows[0])).toEqual({ appointmentId: 7 });
    expect(rows[1]).toMatchObject({ template: "generica", status: "queued", to_email: "medico@example.com", attempts: 0 });
    expect(payloadOf(rows[1])).toEqual({ appointmentId: 7 });
    expect(JSON.stringify(rows)).not.toContain(SECRET);

    // El aviso genérico sale en el siguiente ciclo.
    transport.failNext(0);
    await processOutbox(deps);
    expect(transport.sent.map((message) => message.subject)).toEqual(["Genérico"]);
  });

  it("sin plantilla de respaldo, al abandonarse solo se elimina la clave", async () => {
    await enqueueSensitive("sensible_sin_respaldo");
    transport.failNext(10);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await processOutbox(deps);
      clock.advance(2 * HOUR);
    }
    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failed");
    expect(payloadOf(rows[0])).toEqual({ appointmentId: 7 });
  });

  it("una plantilla sin claves sensibles conserva su payload como siempre", async () => {
    await enqueueEmail(pool, { template: "normal", to: "ana@example.com", payload: { appointmentId: 3, extra: "valor" } }, clock);
    await processOutbox(deps);
    expect(payloadOf((await outbox())[0])).toEqual({ appointmentId: 3, extra: "valor" });
  });

  it("los eventos de registro técnico no incluyen el payload ni la clave", async () => {
    await enqueueSensitive();
    transport.failNext(10);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await processOutbox(deps);
      clock.advance(2 * HOUR);
    }
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain(SECRET);
    for (const event of events) expect(Object.keys(event).sort().every((key) => ["attempts", "errorCode", "errorName", "event", "id", "template"].includes(key))).toBe(true);
  });

  it("si el envío tiene éxito pero la fila ya no está en cola, no se pierde nada", async () => {
    await enqueueSensitive();
    await processOutbox(deps);
    const again = await processOutbox(deps);
    expect(again).toEqual({ sent: 0, retried: 0, failed: 0, cancelled: 0 });
    expect(payloadOf((await outbox())[0])).toEqual({ appointmentId: 7 });
  });
});
