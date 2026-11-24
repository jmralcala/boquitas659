import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictError, ValidationError } from "../../src/http/errors.js";
import { createFixedClock } from "../../src/lib/clock.js";
import { createTenantContext, type StaffContext } from "../../src/lib/tenant.js";
import { getDay } from "../../src/modules/calendar/agenda-service.js";
import { createAppointment } from "../../src/modules/calendar/appointment-service.js";
import { BlockConflictError, blockSlot, createBlock } from "../../src/modules/calendar/block-service.js";
import {
  clearTables,
  createAppointment as insertAppointment,
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
const clock = createFixedClock(new Date("2026-06-15T14:00:00.000Z")); // lunes 8:00 locales
const deps = { db: pool, clock, ticketSecret: "s".repeat(40) };
const MX = "America/Mexico_City";
const TUESDAY = "2026-06-16";
const WEDNESDAY = "2026-06-17";

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

interface Scenario {
  doctor: CreatedDoctor;
  ctx: StaffContext;
  patientId: number;
}

async function scenario(): Promise<Scenario> {
  const doctor = await createDoctor(pool);
  await createCalendarSettings(pool, doctor.doctorId);
  await createCalendarHours(pool, doctor.doctorId, WEEKDAY_HOURS);
  const patient = await createPatient(pool, { fullName: "Ana Pérez" });
  await linkPatientToDoctor(pool, doctor.doctorId, patient.patientId);
  return { doctor, ctx: createTenantContext(doctor.doctorId, { kind: "doctor", userId: doctor.user.id }), patientId: patient.patientId };
}

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

const range = (fromDate: string, fromTime: string, toDate: string, toTime: string) => ({
  fromLocal: `${fromDate}T${fromTime}`,
  toLocal: `${toDate}T${toTime}`,
});

describe("createBlock: rango sin citas", () => {
  it("bloquea el rango y los espacios dejan de estar disponibles", async () => {
    const s = await scenario();
    const result = await createBlock(s.ctx, deps, { ...range(TUESDAY, "09:00", TUESDAY, "12:00"), reason: "Congreso" });
    const [row] = await rows("SELECT * FROM calendar_block WHERE id = ?", [result.id]);
    expect(row).toMatchObject({ doctor_id: s.doctor.doctorId, reason: "Congreso", created_by_user_id: s.doctor.user.id, created_by_role: "doctor" });
    expect((row?.start_utc as Date).toISOString()).toBe(localAt(MX, TUESDAY, "09:00").toISOString());
    expect((row?.end_utc as Date).toISOString()).toBe(localAt(MX, TUESDAY, "12:00").toISOString());

    const day = await getDay(s.ctx, pool, TUESDAY, clock.now());
    // Espacios del martes: 9, 10, 11, 12, 13, 16, 17, 18 → los tres primeros bloqueados (el bloqueo termina a las 12:00).
    expect(day.slots.map((slot) => slot.state)).toEqual(["blocked", "blocked", "blocked", "free", "free", "free", "free", "free"]);
    await expect(createAppointment(s.ctx, deps, { startLocal: `${TUESDAY}T10:00`, patientId: s.patientId })).rejects.toBeInstanceOf(ConflictError);
  });

  it("registra block_created con quién y el id del bloqueo", async () => {
    const s = await scenario();
    const result = await createBlock(s.ctx, deps, range(TUESDAY, "09:00", TUESDAY, "10:00"));
    expect(await rows("SELECT actor_user_id, actor_role, action, block_id, outcome FROM calendar_action_log")).toEqual([
      { actor_user_id: s.doctor.user.id, actor_role: "doctor", action: "block_created", block_id: result.id, outcome: "ok" },
    ]);
  });

  it("acepta un rango de varios días (vacaciones) aunque cruce días sin horario", async () => {
    const s = await scenario();
    await expect(createBlock(s.ctx, deps, range("2026-06-20", "00:00", "2026-07-06", "00:00"))).resolves.toBeDefined();
    const week = await getDay(s.ctx, pool, "2026-06-22", clock.now());
    expect(week.slots.every((slot) => slot.state === "blocked")).toBe(true);
  });

  it("acepta bloqueos solapados", async () => {
    const s = await scenario();
    await createBlock(s.ctx, deps, range(TUESDAY, "09:00", TUESDAY, "12:00"));
    await expect(createBlock(s.ctx, deps, range(TUESDAY, "10:00", TUESDAY, "14:00"))).resolves.toBeDefined();
    expect(await rows("SELECT id FROM calendar_block")).toHaveLength(2);
  });

  it("la recepción puede bloquear y el bloqueo queda a su nombre", async () => {
    const s = await scenario();
    const person = await createUser(pool, { role: "reception" });
    await createMembership(pool, s.doctor.doctorId, person.id);
    const ctx = createTenantContext(s.doctor.doctorId, { kind: "reception", userId: person.id });
    const result = await createBlock(ctx, deps, range(TUESDAY, "09:00", TUESDAY, "10:00"));
    expect(await rows("SELECT created_by_user_id, created_by_role FROM calendar_block WHERE id = ?", [result.id])).toEqual([
      { created_by_user_id: person.id, created_by_role: "reception" },
    ]);
  });
});

describe("createBlock: rango con citas (rechazo total)", () => {
  it("se rechaza completo, con la lista de cada cita en conflicto, sin insertar nada y registrando block_rejected", async () => {
    const s = await scenario();
    const other = await createPatient(pool, { fullName: "Luis Gómez" });
    await linkPatientToDoctor(pool, s.doctor.doctorId, other.patientId);
    const a = await insertAppointment(pool, { doctorId: s.doctor.doctorId, patientId: s.patientId, startUtc: localAt(MX, TUESDAY, "10:00") });
    const b = await insertAppointment(pool, { doctorId: s.doctor.doctorId, patientId: other.patientId, startUtc: localAt(MX, TUESDAY, "12:00") });

    const error = await createBlock(s.ctx, deps, range(TUESDAY, "09:00", TUESDAY, "13:00")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BlockConflictError);
    const conflict = error as BlockConflictError;
    expect(conflict.status).toBe(409);
    expect(conflict.total).toBe(2);
    expect(conflict.appointments.map((item) => [item.id, item.patientName])).toEqual([
      [a, "Ana Pérez"],
      [b, "Luis Gómez"],
    ]);
    expect(conflict.appointments[0]?.startUtc.toISOString()).toBe(localAt(MX, TUESDAY, "10:00").toISOString());

    expect(await rows("SELECT id FROM calendar_block")).toEqual([]);
    expect(await rows("SELECT actor_user_id, action, outcome FROM calendar_action_log")).toEqual([
      { actor_user_id: s.doctor.user.id, action: "block_rejected", outcome: "rejected" },
    ]);
    // Las citas no se tocaron.
    expect(await rows("SELECT status FROM appointment ORDER BY id")).toEqual([{ status: "booked" }, { status: "booked" }]);
  });

  it("no bloquea ni un espacio de forma parcial: los espacios libres del rango siguen libres", async () => {
    const s = await scenario();
    await insertAppointment(pool, { doctorId: s.doctor.doctorId, patientId: s.patientId, startUtc: localAt(MX, TUESDAY, "12:00") });
    await expect(createBlock(s.ctx, deps, range(TUESDAY, "09:00", TUESDAY, "14:00"))).rejects.toBeInstanceOf(BlockConflictError);
    const day = await getDay(s.ctx, pool, TUESDAY, clock.now());
    expect(day.slots.map((slot) => slot.state)).toEqual(["free", "free", "free", "booked", "free", "free", "free", "free"]);
  });

  it("tras cancelar esas citas, el mismo bloqueo se aplica", async () => {
    const s = await scenario();
    const id = await insertAppointment(pool, { doctorId: s.doctor.doctorId, patientId: s.patientId, startUtc: localAt(MX, TUESDAY, "10:00") });
    await expect(createBlock(s.ctx, deps, range(TUESDAY, "09:00", TUESDAY, "12:00"))).rejects.toBeInstanceOf(BlockConflictError);
    await pool.execute("UPDATE appointment SET status = 'cancelled' WHERE id = ?", [id]);
    await expect(createBlock(s.ctx, deps, range(TUESDAY, "09:00", TUESDAY, "12:00"))).resolves.toBeDefined();
  });

  it("una cita ya pasada dentro del rango no lo impide", async () => {
    const s = await scenario();
    await insertAppointment(pool, { doctorId: s.doctor.doctorId, patientId: s.patientId, startUtc: localAt(MX, "2026-06-12", "10:00") });
    await expect(createBlock(s.ctx, deps, range("2026-06-12", "00:00", WEDNESDAY, "00:00"))).resolves.toBeDefined();
  });

  it("una cita que termina justo cuando empieza el bloqueo no cuenta", async () => {
    const s = await scenario();
    await insertAppointment(pool, { doctorId: s.doctor.doctorId, patientId: s.patientId, startUtc: localAt(MX, TUESDAY, "09:00"), endUtc: localAt(MX, TUESDAY, "09:45") });
    await expect(createBlock(s.ctx, deps, range(TUESDAY, "09:45", TUESDAY, "12:00"))).resolves.toBeDefined();
  });

  it("una cita cancelada no cuenta", async () => {
    const s = await scenario();
    await insertAppointment(pool, { doctorId: s.doctor.doctorId, patientId: s.patientId, startUtc: localAt(MX, TUESDAY, "10:00"), status: "cancelled" });
    await expect(createBlock(s.ctx, deps, range(TUESDAY, "09:00", TUESDAY, "12:00"))).resolves.toBeDefined();
  });

  it("las citas de otro médico no cuentan", async () => {
    const s = await scenario();
    const other = await scenario();
    await insertAppointment(pool, { doctorId: other.doctor.doctorId, patientId: other.patientId, startUtc: localAt(MX, TUESDAY, "10:00") });
    await expect(createBlock(s.ctx, deps, range(TUESDAY, "09:00", TUESDAY, "12:00"))).resolves.toBeDefined();
  });

  it("la lista se limita a 50 citas pero informa el total", async () => {
    const s = await scenario();
    await pool.execute("UPDATE calendar_settings SET slot_minutes = 15, gap_minutes = 0 WHERE doctor_id = ?", [s.doctor.doctorId]);
    const start = localAt(MX, "2026-06-23", "00:00").getTime();
    const values: unknown[] = [];
    const placeholders: string[] = [];
    for (let index = 0; index < 60; index += 1) {
      const from = new Date(start + index * 15 * 60_000);
      placeholders.push("(?, ?, ?, ?, 'booked', ?, 'doctor', UTC_TIMESTAMP(3))");
      values.push(s.doctor.doctorId, s.patientId, from, new Date(from.getTime() + 15 * 60_000), s.doctor.user.id);
    }
    await pool.execute(
      `INSERT INTO appointment (doctor_id, patient_id, start_utc, end_utc, status, created_by_user_id, created_by_role, created_at) VALUES ${placeholders.join(", ")}`,
      values as never[],
    );
    const error = (await createBlock(s.ctx, deps, range("2026-06-23", "00:00", "2026-06-24", "00:00")).catch((e: unknown) => e)) as BlockConflictError;
    expect(error).toBeInstanceOf(BlockConflictError);
    expect(error.appointments).toHaveLength(50);
    expect(error.total).toBe(60);
  });
});

describe("createBlock: rangos no válidos", () => {
  it.each([
    ["fin antes del inicio", range(TUESDAY, "12:00", TUESDAY, "09:00")],
    ["fin igual al inicio", range(TUESDAY, "12:00", TUESDAY, "12:00")],
    ["fin en el pasado", range("2026-06-10", "09:00", "2026-06-12", "09:00")],
    ["más de 366 días", range(TUESDAY, "00:00", "2027-06-18", "00:00")],
    ["inicio mal formado", { fromLocal: "mañana", toLocal: `${TUESDAY}T12:00` }],
    ["fin mal formado", { fromLocal: `${TUESDAY}T09:00`, toLocal: "2026-02-30T10:00" }],
  ])("rechaza un rango con %s (400) sin insertar nada", async (_name, input) => {
    const s = await scenario();
    await expect(createBlock(s.ctx, deps, input)).rejects.toBeInstanceOf(ValidationError);
    expect(await rows("SELECT id FROM calendar_block")).toEqual([]);
  });

  it.each([
    ["un inicio a más de 730 días", range("2028-06-16", "09:00", "2028-06-16", "10:00")],
    ["un fin a más de 730 días", range(TUESDAY, "09:00", "2028-06-16", "10:00")],
    ["un año imposible (9999)", range("9999-12-30", "09:00", "9999-12-31", "10:00")],
    ["un inicio de hace más de 365 días con fin futuro", range("2025-06-01", "09:00", TUESDAY, "10:00")],
  ])("rechaza %s (400) sin insertar nada", async (_name, input) => {
    const s = await scenario();
    await expect(createBlock(s.ctx, deps, input)).rejects.toBeInstanceOf(ValidationError);
    expect(await rows("SELECT id FROM calendar_block")).toEqual([]);
  });

  it("acepta justo 730 días hacia adelante", async () => {
    const s = await scenario();
    await expect(createBlock(s.ctx, deps, range("2028-06-14", "09:00", "2028-06-14", "10:00"))).resolves.toBeDefined();
  });

  it("acepta justo 366 días", async () => {
    const s = await scenario();
    await expect(createBlock(s.ctx, deps, range(TUESDAY, "00:00", "2027-06-17", "00:00"))).resolves.toBeDefined();
  });

  it("rechaza un motivo de más de 200 caracteres y acepta uno de 200", async () => {
    const s = await scenario();
    await expect(createBlock(s.ctx, deps, { ...range(TUESDAY, "09:00", TUESDAY, "10:00"), reason: "x".repeat(201) })).rejects.toBeInstanceOf(ValidationError);
    await expect(createBlock(s.ctx, deps, { ...range(TUESDAY, "09:00", TUESDAY, "10:00"), reason: "x".repeat(200) })).resolves.toBeDefined();
  });

  it("un rango que empieza en el pasado pero termina en el futuro es válido", async () => {
    const s = await scenario();
    await expect(createBlock(s.ctx, deps, range("2026-06-12", "09:00", TUESDAY, "09:00"))).resolves.toBeDefined();
  });
});

describe("blockSlot (atajo desde la agenda)", () => {
  it("bloquea exactamente el rango del espacio", async () => {
    const s = await scenario();
    const result = await blockSlot(s.ctx, deps, `${TUESDAY}T10:00`);
    const [row] = await rows("SELECT start_utc, end_utc FROM calendar_block WHERE id = ?", [result.id]);
    expect((row?.start_utc as Date).toISOString()).toBe(localAt(MX, TUESDAY, "10:00").toISOString());
    expect((row?.end_utc as Date).toISOString()).toBe(localAt(MX, TUESDAY, "10:45").toISOString());
    const day = await getDay(s.ctx, pool, TUESDAY, clock.now());
    expect(day.slots.map((slot) => slot.state)).toEqual(["free", "blocked", "free", "free", "free", "free", "free", "free"]);
  });

  it("un espacio con cita se rechaza con la lista de conflicto", async () => {
    const s = await scenario();
    await insertAppointment(pool, { doctorId: s.doctor.doctorId, patientId: s.patientId, startUtc: localAt(MX, TUESDAY, "10:00") });
    const error = (await blockSlot(s.ctx, deps, `${TUESDAY}T10:00`).catch((e: unknown) => e)) as BlockConflictError;
    expect(error).toBeInstanceOf(BlockConflictError);
    expect(error.total).toBe(1);
  });

  it("un inicio que no es un espacio del horario es un 400", async () => {
    const s = await scenario();
    await expect(blockSlot(s.ctx, deps, `${TUESDAY}T10:20`)).rejects.toBeInstanceOf(ValidationError);
    await expect(blockSlot(s.ctx, deps, `${TUESDAY}T20:00`)).rejects.toBeInstanceOf(ValidationError);
  });

  it("un espacio que ya terminó es un 400", async () => {
    const s = await scenario();
    clock.set(new Date("2026-06-16T20:00:00.000Z")); // martes 14:00 locales
    await expect(blockSlot(s.ctx, deps, `${TUESDAY}T10:00`)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("un bloqueo nunca altera citas", () => {
  it("las citas quedan idénticas antes y después de bloquear en otro horario", async () => {
    const s = await scenario();
    await insertAppointment(pool, { doctorId: s.doctor.doctorId, patientId: s.patientId, startUtc: localAt(MX, TUESDAY, "10:00") });
    const before = await rows("SELECT id, start_utc, end_utc, status, cancelled_at FROM appointment");
    await createBlock(s.ctx, deps, range(WEDNESDAY, "09:00", WEDNESDAY, "14:00"));
    await insertBlock(pool, { doctorId: s.doctor.doctorId, startUtc: localAt(MX, "2026-06-18", "09:00"), endUtc: localAt(MX, "2026-06-18", "10:00") });
    expect(await rows("SELECT id, start_utc, end_utc, status, cancelled_at FROM appointment")).toEqual(before);
  });
});
