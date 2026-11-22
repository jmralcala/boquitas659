import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFixedClock, type FixedClock } from "../../src/lib/clock.js";
import {
  INVITATION_TTL_MS,
  PASSWORD_RESET_TTL_MS,
  createOneTimeTokenService,
  type OneTimeTokenService,
} from "../../src/modules/auth/one-time-tokens.js";
import { clearTables, createDoctor, createInvitation, createTestPool, createUser, resetDatabase } from "./helpers/db.js";

const pool = createTestPool();
const MINUTE = 60_000;

let clock: FixedClock;
let tokens: OneTimeTokenService;
let userId: number;

beforeAll(async () => {
  await resetDatabase(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  clock = createFixedClock(new Date("2026-06-01T10:00:00.000Z"));
  tokens = createOneTimeTokenService(pool, clock);
  userId = (await createUser(pool)).id;
});

afterAll(async () => {
  await pool.end();
});

describe("OneTimeTokenService", () => {
  it("define las caducidades: 30 minutos para recuperación y 7 días para invitación", () => {
    expect(PASSWORD_RESET_TTL_MS).toBe(30 * MINUTE);
    expect(INVITATION_TTL_MS).toBe(7 * 24 * 60 * MINUTE);
  });

  it("peek valida sin consumir, tantas veces como se quiera", async () => {
    const { token } = await tokens.create({ purpose: "password_reset", userId, ttlMs: PASSWORD_RESET_TTL_MS });
    expect(await tokens.peek(token, "password_reset")).toEqual({ userId, invitationId: null });
    expect(await tokens.peek(token, "password_reset")).toEqual({ userId, invitationId: null });
    expect(await tokens.consume(token, "password_reset")).toEqual({ userId, invitationId: null });
  });

  it("consume solo funciona una vez", async () => {
    const { token } = await tokens.create({ purpose: "password_reset", userId, ttlMs: PASSWORD_RESET_TTL_MS });
    expect(await tokens.consume(token, "password_reset")).not.toBeNull();
    expect(await tokens.consume(token, "password_reset")).toBeNull();
    expect(await tokens.peek(token, "password_reset")).toBeNull();
  });

  it("se rechaza vencido: a los 30 minutos la recuperación, a los 7 días la invitación", async () => {
    const reset = await tokens.create({ purpose: "password_reset", userId, ttlMs: PASSWORD_RESET_TTL_MS });
    const doctor = await createDoctor(pool);
    const invitationId = await createInvitation(pool, { doctorId: doctor.doctorId, invitedByUserId: doctor.user.id, email: "persona@example.com" });
    const invite = await tokens.create({ purpose: "reception_invite", invitationId, ttlMs: INVITATION_TTL_MS });

    clock.advance(29 * MINUTE);
    expect(await tokens.peek(reset.token, "password_reset")).not.toBeNull();
    clock.advance(2 * MINUTE);
    expect(await tokens.peek(reset.token, "password_reset")).toBeNull();
    expect(await tokens.consume(reset.token, "password_reset")).toBeNull();

    expect(await tokens.peek(invite.token, "reception_invite")).toEqual({ userId: null, invitationId });
    clock.advance(7 * 24 * 60 * MINUTE);
    expect(await tokens.consume(invite.token, "reception_invite")).toBeNull();
  });

  it("no sirve para otro propósito", async () => {
    const { token } = await tokens.create({ purpose: "password_reset", userId, ttlMs: PASSWORD_RESET_TTL_MS });
    expect(await tokens.peek(token, "reception_invite")).toBeNull();
    expect(await tokens.consume(token, "reception_invite")).toBeNull();
    expect(await tokens.consume(token, "password_reset")).not.toBeNull();
  });

  it("con consumos simultáneos exactamente uno gana", async () => {
    const { token } = await tokens.create({ purpose: "password_reset", userId, ttlMs: PASSWORD_RESET_TTL_MS });
    const results = await Promise.all(Array.from({ length: 8 }, () => tokens.consume(token, "password_reset")));
    expect(results.filter((result) => result !== null)).toHaveLength(1);
  });

  it("solo se guarda el hash del token", async () => {
    const { token } = await tokens.create({ purpose: "password_reset", userId, ttlMs: PASSWORD_RESET_TTL_MS });
    const [rows] = await pool.query<RowDataPacket[]>("SELECT token_hash FROM one_time_token");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.token_hash).not.toBe(token);
  });

  it("crear uno nuevo invalida los vigentes del mismo propósito y sujeto", async () => {
    const first = await tokens.create({ purpose: "password_reset", userId, ttlMs: PASSWORD_RESET_TTL_MS });
    const second = await tokens.create({ purpose: "password_reset", userId, ttlMs: PASSWORD_RESET_TTL_MS });
    expect(await tokens.peek(first.token, "password_reset")).toBeNull();
    expect(await tokens.peek(second.token, "password_reset")).not.toBeNull();

    const otherUser = (await createUser(pool)).id;
    const third = await tokens.create({ purpose: "password_reset", userId: otherUser, ttlMs: PASSWORD_RESET_TTL_MS });
    expect(await tokens.peek(second.token, "password_reset")).not.toBeNull();
    expect(await tokens.peek(third.token, "password_reset")).not.toBeNull();
  });

  it("rechaza tokens vacíos o desconocidos", async () => {
    expect(await tokens.peek("", "password_reset")).toBeNull();
    expect(await tokens.consume("desconocido", "password_reset")).toBeNull();
  });
});
