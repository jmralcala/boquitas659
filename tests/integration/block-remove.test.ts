import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NotFoundError } from "../../src/http/errors.js";
import { createFixedClock } from "../../src/lib/clock.js";
import { createTenantContext, type StaffContext } from "../../src/lib/tenant.js";
import { getDay } from "../../src/modules/calendar/agenda-service.js";
import { createAppointment } from "../../src/modules/calendar/appointment-service.js";
import { createBlock, removeBlock } from "../../src/modules/calendar/block-service.js";
import {
  clearTables,
  createBlock as insertBlock,
  createCalendarHours,
  createCalendarSettings,
  createDoctor,
  createMembership,
  createPatient,
  createTestPool,
  createUser,
  linkPatientToDoctor,
  resetDatabase,
  WEEKDAY_HOURS,
  type CreatedDoctor,
} from "./helpers/db.js";
import { localAt } from "./helpers/app.js";

const pool = createTestPool();
const clock = createFixedClock(new Date("2026-06-15T14:00:00.000Z"));
const deps = { db: pool, clock, ticketSecret: "s".repeat(40) };
const MX = "America/Mexico_City";
const TUESDAY = "2026-06-16";

beforeAll(async () => {
  await resetDatabase(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  clock.set(new Date("2026-06-15T14:00:00.000Z"));
});

afterAll(async () => {
  await pool.end();
});

async function scenario(): Promise<{ doctor: CreatedDoctor; ctx: StaffContext; patientId: number }> {
  const doctor = await createDoctor(pool);
  await createCalendarSettings(pool, doctor.doctorId);
  await createCalendarHours(pool, doctor.doctorId, WEEKDAY_HOURS);
  const patient = await createPatient(pool);
  await linkPatientToDoctor(pool, doctor.doctorId, patient.patientId);
  return { doctor, ctx: createTenantContext(doctor.doctorId, { kind: "doctor", userId: doctor.user.id }), patientId: patient.patientId };
}

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

describe("removeBlock", () => {
  it("borra el bloqueo completo y libera sus espacios", async () => {
    const s = await scenario();
    const { id } = await createBlock(s.ctx, deps, { fromLocal: `${TUESDAY}T09:00`, toLocal: `${TUESDAY}T14:00` });
    expect((await getDay(s.ctx, pool, TUESDAY, clock.now())).slots.slice(0, 5).every((slot) => slot.state === "blocked")).toBe(true);
    await removeBlock(s.ctx, deps, id);
    expect(await rows("SELECT id FROM calendar_block")).toEqual([]);
    expect((await getDay(s.ctx, pool, TUESDAY, clock.now())).slots.every((slot) => slot.state === "free")).toBe(true);
    // Y ya se puede agendar de nuevo.
    await expect(createAppointment(s.ctx, deps, { startLocal: `${TUESDAY}T10:00`, patientId: s.patientId })).resolves.toBeDefined();
  });

  it("con dos bloqueos solapados, borrar uno no libera lo que el otro todavía cubre", async () => {
    const s = await scenario();
    const first = await createBlock(s.ctx, deps, { fromLocal: `${TUESDAY}T09:00`, toLocal: `${TUESDAY}T12:00` });
    await createBlock(s.ctx, deps, { fromLocal: `${TUESDAY}T10:00`, toLocal: `${TUESDAY}T14:00` });
    await removeBlock(s.ctx, deps, first.id);
    const day = await getDay(s.ctx, pool, TUESDAY, clock.now());
    // El segundo bloqueo cubre de 10:00 a 14:00: el espacio de las 9:00 queda libre y los demás siguen bloqueados.
    expect(day.slots.map((slot) => slot.state)).toEqual(["free", "blocked", "blocked", "blocked", "blocked", "free", "free", "free"]);
  });

  it("registra block_removed con quién y el id, aunque el bloqueo ya no exista", async () => {
    const s = await scenario();
    const { id } = await createBlock(s.ctx, deps, { fromLocal: `${TUESDAY}T09:00`, toLocal: `${TUESDAY}T10:00` });
    await removeBlock(s.ctx, deps, id);
    expect(await rows("SELECT actor_user_id, actor_role, action, block_id, outcome FROM calendar_action_log ORDER BY id")).toEqual([
      { actor_user_id: s.doctor.user.id, actor_role: "doctor", action: "block_created", block_id: id, outcome: "ok" },
      { actor_user_id: s.doctor.user.id, actor_role: "doctor", action: "block_removed", block_id: id, outcome: "ok" },
    ]);
  });

  it("un bloqueo de otro médico o inexistente es NotFoundError y no cambia", async () => {
    const a = await scenario();
    const b = await scenario();
    const id = await insertBlock(pool, { doctorId: a.doctor.doctorId, startUtc: localAt(MX, TUESDAY, "09:00"), endUtc: localAt(MX, TUESDAY, "10:00") });
    await expect(removeBlock(b.ctx, deps, id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(removeBlock(b.ctx, deps, 9_999_999)).rejects.toBeInstanceOf(NotFoundError);
    expect(await rows("SELECT id FROM calendar_block")).toHaveLength(1);
    expect(await rows("SELECT id FROM calendar_action_log")).toEqual([]);
  });

  it("borrar dos veces el mismo bloqueo: la segunda es NotFoundError", async () => {
    const s = await scenario();
    const { id } = await createBlock(s.ctx, deps, { fromLocal: `${TUESDAY}T09:00`, toLocal: `${TUESDAY}T10:00` });
    await removeBlock(s.ctx, deps, id);
    await expect(removeBlock(s.ctx, deps, id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("la recepción puede desbloquear y la acción queda a su nombre", async () => {
    const s = await scenario();
    const person = await createUser(pool, { role: "reception" });
    await createMembership(pool, s.doctor.doctorId, person.id);
    const receptionCtx = createTenantContext(s.doctor.doctorId, { kind: "reception", userId: person.id });
    const { id } = await createBlock(s.ctx, deps, { fromLocal: `${TUESDAY}T09:00`, toLocal: `${TUESDAY}T10:00` });
    await removeBlock(receptionCtx, deps, id);
    expect(await rows("SELECT actor_user_id, actor_role FROM calendar_action_log WHERE action = 'block_removed'")).toEqual([
      { actor_user_id: person.id, actor_role: "reception" },
    ]);
  });
});
