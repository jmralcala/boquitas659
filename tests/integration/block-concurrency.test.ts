import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictError } from "../../src/http/errors.js";
import { createFixedClock } from "../../src/lib/clock.js";
import { createTenantContext, type StaffContext } from "../../src/lib/tenant.js";
import { addLocalDays } from "../../src/lib/zoned-time.js";
import { cancelAppointment, createAppointment } from "../../src/modules/calendar/appointment-service.js";
import { BlockConflictError, createBlock } from "../../src/modules/calendar/block-service.js";
import {
  clearTables,
  createAppointment as insertAppointment,
  createCalendarHours,
  createCalendarSettings,
  createDoctor,
  createPatient,
  createTestPool,
  linkPatientToDoctor,
  resetDatabase,
  WEEKDAY_HOURS,
} from "./helpers/db.js";
import { localAt } from "./helpers/app.js";

// Obligatoria por la constitución (principio III): bloquear y reservar en simultáneo nunca dejan una cita dentro de un bloqueo.
const pool = createTestPool();
const clock = createFixedClock(new Date("2026-06-15T14:00:00.000Z"));
const deps = { db: pool, clock, ticketSecret: "s".repeat(40) };
const MX = "America/Mexico_City";

beforeAll(async () => {
  await resetDatabase(pool);
});

beforeEach(async () => {
  await clearTables(pool);
});

afterAll(async () => {
  await pool.end();
});

async function setup(): Promise<{ ctx: StaffContext; doctorId: number; patientId: number }> {
  const doctor = await createDoctor(pool);
  await createCalendarSettings(pool, doctor.doctorId);
  await createCalendarHours(pool, doctor.doctorId, WEEKDAY_HOURS);
  const patient = await createPatient(pool);
  await linkPatientToDoctor(pool, doctor.doctorId, patient.patientId);
  return { ctx: createTenantContext(doctor.doctorId, { kind: "doctor", userId: doctor.user.id }), doctorId: doctor.doctorId, patientId: patient.patientId };
}

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

/** Días hábiles consecutivos a partir de mañana. */
function businessDays(count: number): string[] {
  const dates: string[] = [];
  for (let day = 1; dates.length < count; day += 1) {
    const date = addLocalDays("2026-06-15", day);
    const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    if (weekday >= 1 && weekday <= 5) dates.push(date);
  }
  return dates;
}

/** Cuántas citas vigentes se solapan con algún bloqueo del médico (debe ser siempre 0). */
async function appointmentsInsideBlocks(doctorId: number): Promise<number> {
  const result = await rows(
    `SELECT COUNT(*) AS n FROM appointment a JOIN calendar_block b ON b.doctor_id = a.doctor_id
      WHERE a.doctor_id = ? AND a.status = 'booked' AND a.start_utc < b.end_utc AND a.end_utc > b.start_utc`,
    [doctorId],
  );
  return Number(result[0]?.n);
}

describe("bloquear y reservar a la vez", () => {
  it("20 rondas sobre el mismo horario: nunca existen un bloqueo y una cita vigente que se solapen, y una de las dos operaciones recibe conflicto", async () => {
    const s = await setup();
    let blockWon = 0;
    let appointmentWon = 0;
    for (const date of businessDays(20)) {
      const roundPatient = await createPatient(pool);
      await linkPatientToDoctor(pool, s.doctorId, roundPatient.patientId);
      const [blockResult, appointmentResult] = await Promise.allSettled([
        createBlock(s.ctx, deps, { fromLocal: `${date}T09:00`, toLocal: `${date}T11:00` }),
        createAppointment(s.ctx, deps, { startLocal: `${date}T10:00`, patientId: roundPatient.patientId }),
      ]);
      // Exactamente una gana: si el bloqueo pasa, la cita recibe conflicto; si la cita pasa, el bloqueo recibe su lista.
      const outcomes = [blockResult.status, appointmentResult.status].sort();
      expect(outcomes).toEqual(["fulfilled", "rejected"]);
      if (blockResult.status === "fulfilled") {
        blockWon += 1;
        expect(appointmentResult.status === "rejected" && appointmentResult.reason).toBeInstanceOf(ConflictError);
      } else {
        appointmentWon += 1;
        expect(blockResult.reason).toBeInstanceOf(BlockConflictError);
      }
      expect(await appointmentsInsideBlocks(s.doctorId)).toBe(0);
    }
    expect(blockWon + appointmentWon).toBe(20);
    // El resultado final es consistente con lo que cada operación reportó.
    expect(await rows("SELECT id FROM calendar_block")).toHaveLength(blockWon);
    expect(await rows("SELECT id FROM appointment WHERE status = 'booked'")).toHaveLength(appointmentWon);
  });

  it("muchas reservas de espacios distintos contra un bloqueo que los cubre: cada una gana o pierde entero, sin mezcla", async () => {
    const s = await setup();
    const date = businessDays(1)[0] ?? "";
    const patients: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      const patient = await createPatient(pool);
      await linkPatientToDoctor(pool, s.doctorId, patient.patientId);
      patients.push(patient.patientId);
    }
    const times = ["09:00", "10:00", "11:00", "12:00"];
    const [blockResult, ...appointmentResults] = await Promise.allSettled([
      createBlock(s.ctx, deps, { fromLocal: `${date}T09:00`, toLocal: `${date}T13:00` }),
      ...times.map((time, index) => createAppointment(s.ctx, deps, { startLocal: `${date}T${time}`, patientId: patients[index] ?? 0 })),
    ]);
    expect(await appointmentsInsideBlocks(s.doctorId)).toBe(0);
    if (blockResult?.status === "fulfilled") {
      // El bloqueo ganó la carrera: todas las reservas que quedaron antes fueron rechazadas; las demás ni existen.
      expect(await rows("SELECT id FROM appointment WHERE status = 'booked'")).toEqual([]);
      expect(appointmentResults.every((result) => result.status === "rejected")).toBe(true);
    } else {
      // Alguna reserva ganó primero: el bloqueo se rechazó entero.
      expect(blockResult?.reason).toBeInstanceOf(BlockConflictError);
      expect(await rows("SELECT id FROM calendar_block")).toEqual([]);
    }
  });

  it("dos bloqueos solapados a la vez: ambos prosperan", async () => {
    const s = await setup();
    const date = businessDays(1)[0] ?? "";
    const results = await Promise.allSettled([
      createBlock(s.ctx, deps, { fromLocal: `${date}T09:00`, toLocal: `${date}T12:00` }),
      createBlock(s.ctx, deps, { fromLocal: `${date}T10:00`, toLocal: `${date}T14:00` }),
      createBlock(s.ctx, deps, { fromLocal: `${date}T09:30`, toLocal: `${date}T10:30` }),
    ]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(await rows("SELECT id FROM calendar_block")).toHaveLength(3);
  });

  it("bloquear y cancelar a la vez: si la cancelación gana, el bloqueo se aplica; si el bloqueo gana, se rechaza con la cita en la lista", async () => {
    const s = await setup();
    let blockApplied = 0;
    let blockRejected = 0;
    for (const date of businessDays(10)) {
      const id = await insertAppointment(pool, { doctorId: s.doctorId, patientId: s.patientId, startUtc: localAt(MX, date, "10:00") });
      const [blockResult, cancelResult] = await Promise.allSettled([
        createBlock(s.ctx, deps, { fromLocal: `${date}T09:00`, toLocal: `${date}T11:00` }),
        cancelAppointment(s.ctx, deps, id),
      ]);
      // La cancelación siempre prospera; el bloqueo solo si la cancelación llegó antes.
      expect(cancelResult.status).toBe("fulfilled");
      if (blockResult.status === "fulfilled") blockApplied += 1;
      else {
        blockRejected += 1;
        const conflict = blockResult.reason as BlockConflictError;
        expect(conflict).toBeInstanceOf(BlockConflictError);
        expect(conflict.appointments.map((item) => item.id)).toEqual([id]);
      }
      expect(await appointmentsInsideBlocks(s.doctorId)).toBe(0);
    }
    expect(blockApplied + blockRejected).toBe(10);
    expect(await rows("SELECT id FROM calendar_block")).toHaveLength(blockApplied);
  });
});
