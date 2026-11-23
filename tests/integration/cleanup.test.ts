import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runCleanup } from "../../src/jobs/cleanup-service.js";
import { createFixedClock, type FixedClock } from "../../src/lib/clock.js";
import { clearTables, createTestPool, createUser, resetDatabase } from "./helpers/db.js";

const pool = createTestPool();
const DAY = 86_400_000;
const NOW = new Date("2026-06-15T12:00:00.000Z");
let clock: FixedClock;
let userId: number;

beforeAll(async () => {
  await resetDatabase(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  clock = createFixedClock(NOW);
  userId = (await createUser(pool)).id;
});

afterAll(async () => {
  await pool.end();
});

const ago = (ms: number) => new Date(NOW.getTime() - ms);
const ahead = (ms: number) => new Date(NOW.getTime() + ms);

async function count(table: string): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${table}\``);
  return Number(rows[0]?.n);
}

async function token(hash: string, expiresAt: Date, usedAt: Date | null): Promise<void> {
  await pool.execute(
    "INSERT INTO one_time_token (token_hash, purpose, user_id, expires_at, used_at, created_at) VALUES (?, 'password_reset', ?, ?, ?, ?)",
    [hash.padEnd(64, "0"), userId, expiresAt, usedAt, ago(10 * DAY)],
  );
}

async function session(hash: string, lastSeen: Date, absoluteExpires: Date, revokedAt: Date | null): Promise<void> {
  await pool.execute(
    "INSERT INTO session (token_hash, user_id, csrf_secret, created_at, last_seen_at, absolute_expires_at, revoked_at) VALUES (?, ?, 'x', ?, ?, ?, ?)",
    [hash.padEnd(64, "0"), userId, ago(10 * DAY), lastSeen, absoluteExpires, revokedAt],
  );
}

async function email(status: "queued" | "sent" | "failed" | "cancelled", createdAt: Date, sentAt: Date | null): Promise<void> {
  await pool.execute(
    "INSERT INTO email_outbox (template, to_email, payload_ref, status, next_attempt_at, sent_at, created_at) VALUES ('t', 'a@example.com', '{}', ?, ?, ?, ?)",
    [status, createdAt, sentAt, createdAt],
  );
}

describe("runCleanup", () => {
  it("borra los tokens usados o vencidos hace más de 1 día y conserva los demás", async () => {
    await token("a", ago(3 * DAY), null); // vencido hace 3 días
    await token("b", ahead(DAY), ago(2 * DAY)); // usado hace 2 días
    await token("c", ago(2 * 3600_000), null); // vencido hace 2 horas: se conserva
    await token("d", ahead(DAY), null); // vigente
    await token("e", ahead(DAY), ago(3600_000)); // usado hace 1 hora: se conserva

    const result = await runCleanup(pool, clock);
    expect(result.tokens).toBe(2);
    expect(await count("one_time_token")).toBe(3);
  });

  it("borra las sesiones revocadas o vencidas hace más de 1 día y las inactivas hace más de 2, y conserva las vigentes", async () => {
    await session("a", ago(60_000), ahead(10 * 3600_000), null); // vigente
    await session("b", ago(60_000), ahead(10 * 3600_000), ago(3 * DAY)); // revocada hace 3 días
    await session("c", ago(60_000), ago(2 * DAY), null); // venció su tope absoluto hace 2 días
    await session("d", ago(3 * DAY), ahead(3600_000), null); // sin actividad hace 3 días
    await session("e", ago(60_000), ahead(10 * 3600_000), ago(3600_000)); // revocada hace 1 hora: se conserva

    const result = await runCleanup(pool, clock);
    expect(result.sessions).toBe(3);
    expect(await count("session")).toBe(2);
  });

  it("borra los entregados y los fallidos hace más de 30 días y los cancelados hace más de 7; nunca los pendientes", async () => {
    await email("sent", ago(41 * DAY), ago(40 * DAY));
    await email("sent", ago(12 * DAY), ago(11 * DAY)); // entregado hace 11 días: se conserva (misma retención que los fallidos)
    await email("sent", ago(2 * DAY), ago(DAY)); // entregado ayer: se conserva
    await email("failed", ago(40 * DAY), null);
    await email("failed", ago(5 * DAY), null); // fallido reciente: se conserva
    await email("cancelled", ago(9 * DAY), null);
    await email("cancelled", ago(2 * DAY), null); // cancelado hace 2 días: se conserva
    await email("queued", ago(90 * DAY), null); // pendiente muy antiguo: no se toca

    const result = await runCleanup(pool, clock);
    expect(result.emails).toBe(3);
    expect(await count("email_outbox")).toBe(5);
    const [queued] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM email_outbox WHERE status = 'queued'");
    expect(Number(queued[0]?.n)).toBe(1);
  });

  it("borra los contadores de intentos sin fallos desde hace más de 1 día", async () => {
    await pool.execute("INSERT INTO login_throttle (scope, key_hash, failures, locked_until, updated_at) VALUES ('account', ?, 3, NULL, ?)", ["a".repeat(64), ago(2 * DAY)]);
    await pool.execute("INSERT INTO login_throttle (scope, key_hash, failures, locked_until, updated_at) VALUES ('account', ?, 3, NULL, ?)", ["b".repeat(64), ago(3600_000)]);
    const result = await runCleanup(pool, clock);
    expect(result.throttle).toBe(1);
    expect(await count("login_throttle")).toBe(1);
  });

  it("es idempotente: repetirla no borra nada más", async () => {
    await token("a", ago(3 * DAY), null);
    await session("b", ago(3 * DAY), ahead(3600_000), null);
    await email("sent", ago(41 * DAY), ago(40 * DAY));
    const first = await runCleanup(pool, clock);
    expect(first).toEqual({ tokens: 1, sessions: 1, emails: 1, throttle: 0, calendarLog: 0 });
    expect(await runCleanup(pool, clock)).toEqual({ tokens: 0, sessions: 0, emails: 0, throttle: 0, calendarLog: 0 });
  });

  it("no toca los registros de solo anexar ni los dispositivos conocidos", async () => {
    const legal = await pool.execute("INSERT INTO legal_document (type, version, title, body, is_provisional, published_at) VALUES ('patient_privacy', 1, 't', 'b', 0, ?)", [ago(400 * DAY)]);
    await pool.execute("INSERT INTO consent_acceptance (user_id, legal_document_id, accepted_at) VALUES (?, ?, ?)", [userId, (legal[0] as { insertId: number }).insertId, ago(400 * DAY)]);
    await pool.execute("INSERT INTO trusted_device (user_id, device_hash, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)", [userId, "d".repeat(64), ago(400 * DAY), ago(400 * DAY)]);
    await runCleanup(pool, clock);
    expect(await count("consent_acceptance")).toBe(1);
    expect(await count("trusted_device")).toBe(1);
  });
});
