import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFixedClock, type FixedClock } from "../../src/lib/clock.js";
import { enqueueEmail, processOutbox, type OutboxDeps } from "../../src/mail/outbox.js";
import type { TemplateRegistry } from "../../src/mail/templates.js";
import { createMemoryTransport, type MemoryTransport } from "../../src/mail/transport.js";
import {
  PASSWORD_RESET_TTL_MS,
  createOneTimeTokenService,
  type OneTimeTokenService,
} from "../../src/modules/auth/one-time-tokens.js";
import { clearTables, createTestPool, createUser, resetDatabase } from "./helpers/db.js";

const pool = createTestPool();
const MINUTE = 60_000;

const templates: TemplateRegistry = {
  simple: {
    render: () => ({ subject: "Asunto de prueba", text: "Cuerpo de prueba con datos privados" }),
  },
  with_link: {
    token: {
      purpose: "password_reset",
      ttlMs: PASSWORD_RESET_TTL_MS,
      linkPath: (token) => `/recuperar/${token}`,
      subject: (payload) => ({ userId: Number(payload.userId) }),
    },
    render: ({ link }) => ({ subject: "Recupera tu contraseña", text: `Enlace: ${link}` }),
  },
};

let clock: FixedClock;
let transport: MemoryTransport;
let tokens: OneTimeTokenService;
let deps: OutboxDeps;

beforeAll(async () => {
  await resetDatabase(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  clock = createFixedClock(new Date("2026-06-01T10:00:00.000Z"));
  transport = createMemoryTransport();
  tokens = createOneTimeTokenService(pool, clock);
  deps = { db: pool, transport, tokens, templates, baseUrl: "https://agenda.example.com", clock, maxAttempts: 3 };
});

afterAll(async () => {
  await pool.end();
});

async function outboxRows(): Promise<RowDataPacket[]> {
  const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM email_outbox ORDER BY id");
  return rows;
}

describe("email_outbox", () => {
  it("encola y envía; marca el correo como enviado", async () => {
    await enqueueEmail(pool, { template: "simple", to: "ana@example.com" }, clock);
    const result = await processOutbox(deps);

    expect(result).toEqual({ sent: 1, retried: 0, failed: 0 });
    expect(transport.sent).toEqual([
      { to: "ana@example.com", subject: "Asunto de prueba", text: "Cuerpo de prueba con datos privados" },
    ]);
    const [row] = await outboxRows();
    expect(row).toMatchObject({ status: "sent", attempts: 1 });
    expect(row?.sent_at).toBeInstanceOf(Date);
  });

  it("solo guarda identificadores en el outbox, nunca el cuerpo enviado", async () => {
    await enqueueEmail(pool, { template: "simple", to: "ana@example.com", payload: { userId: 7 } }, clock);
    await processOutbox(deps);
    const rows = await outboxRows();
    expect(JSON.stringify(rows)).not.toContain("datos privados");
    expect(JSON.parse(String(rows[0]?.payload_ref))).toEqual({ userId: 7 });
  });

  it("reintenta con espera creciente y queda en failed tras agotar los intentos", async () => {
    await enqueueEmail(pool, { template: "simple", to: "ana@example.com" }, clock);
    transport.failNext(10);

    expect(await processOutbox(deps)).toEqual({ sent: 0, retried: 1, failed: 0 });
    let [row] = await outboxRows();
    expect(row).toMatchObject({ status: "queued", attempts: 1 });
    expect((row?.next_attempt_at as Date).getTime()).toBe(clock.now().getTime() + 1 * MINUTE);

    // Aún no vence la espera: no se intenta.
    clock.advance(30_000);
    expect(await processOutbox(deps)).toEqual({ sent: 0, retried: 0, failed: 0 });

    clock.advance(31_000);
    expect(await processOutbox(deps)).toEqual({ sent: 0, retried: 1, failed: 0 });
    [row] = await outboxRows();
    expect((row?.next_attempt_at as Date).getTime()).toBe(clock.now().getTime() + 2 * MINUTE);

    clock.advance(3 * MINUTE);
    expect(await processOutbox(deps)).toEqual({ sent: 0, retried: 0, failed: 1 });
    [row] = await outboxRows();
    expect(row).toMatchObject({ status: "failed", attempts: 3 });

    // Ya no se vuelve a intentar.
    clock.advance(60 * MINUTE);
    expect(await processOutbox(deps)).toEqual({ sent: 0, retried: 0, failed: 0 });
    expect(transport.sent).toHaveLength(0);
  });

  it("un reintento exitoso envía el correo una sola vez", async () => {
    await enqueueEmail(pool, { template: "simple", to: "ana@example.com" }, clock);
    transport.failNext(1);
    await processOutbox(deps);
    clock.advance(2 * MINUTE);
    expect(await processOutbox(deps)).toEqual({ sent: 1, retried: 0, failed: 0 });
    expect(await processOutbox(deps)).toEqual({ sent: 0, retried: 0, failed: 0 });
    expect(transport.sent).toHaveLength(1);
  });

  it("con procesos simultáneos cada correo se envía exactamente una vez", async () => {
    for (let i = 0; i < 6; i += 1) {
      await enqueueEmail(pool, { template: "simple", to: `u${i}@example.com` }, clock);
    }
    const results = await Promise.all([processOutbox(deps), processOutbox(deps), processOutbox(deps)]);
    expect(results.reduce((total, r) => total + r.sent, 0)).toBe(6);
    expect(transport.sent).toHaveLength(6);
    expect(new Set(transport.sent.map((m) => m.to)).size).toBe(6);
  });

  it("una plantilla desconocida no bloquea a las demás", async () => {
    await enqueueEmail(pool, { template: "no_existe", to: "a@example.com" }, clock);
    await enqueueEmail(pool, { template: "simple", to: "b@example.com" }, clock);
    const result = await processOutbox(deps);
    expect(result.sent).toBe(1);
    expect(result.retried).toBe(1);
  });
});

describe("plantillas con enlace de un solo uso", () => {
  it("el token se crea al enviar, el enlace funciona y no queda en claro en la base", async () => {
    const user = await createUser(pool);
    await enqueueEmail(pool, { template: "with_link", to: user.email, payload: { userId: user.id } }, clock);

    const [before] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM one_time_token");
    expect(Number(before[0]?.n)).toBe(0);

    await processOutbox(deps);

    const link = transport.sent[0]?.text.replace("Enlace: ", "") ?? "";
    expect(link).toMatch(/^https:\/\/agenda\.example\.com\/recuperar\/[A-Za-z0-9_-]{43}$/);
    const token = link.split("/").pop() ?? "";
    expect(await tokens.peek(token, "password_reset")).toEqual({ userId: user.id, invitationId: null });

    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM one_time_token");
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(await outboxRows())).not.toContain(token);
  });

  it("si el envío falla no queda ningún token y el anterior sigue vigente; el reintento deja uno solo", async () => {
    const user = await createUser(pool);
    const previous = await tokens.create({ purpose: "password_reset", userId: user.id, ttlMs: PASSWORD_RESET_TTL_MS });
    await enqueueEmail(pool, { template: "with_link", to: user.email, payload: { userId: user.id } }, clock);

    transport.failNext(1);
    await processOutbox(deps);
    expect(await tokens.peek(previous.token, "password_reset")).not.toBeNull();
    const [afterFailure] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM one_time_token");
    expect(Number(afterFailure[0]?.n)).toBe(1);

    clock.advance(2 * MINUTE);
    await processOutbox(deps);
    expect(await tokens.peek(previous.token, "password_reset")).toBeNull();
    const [valid] = await pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM one_time_token WHERE used_at IS NULL AND expires_at > ?",
      [clock.now()],
    );
    expect(Number(valid[0]?.n)).toBe(1);
  });
});
