import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictError, TooManyAttemptsError } from "../../src/http/errors.js";
import { createFixedClock } from "../../src/lib/clock.js";
import { createPatientContext, createTenantContext, type StaffContext } from "../../src/lib/tenant.js";
import { addLocalDays } from "../../src/lib/zoned-time.js";
import { cancelAppointment } from "../../src/modules/calendar/appointment-service.js";
import { BlockConflictError, blockSlot } from "../../src/modules/calendar/block-service.js";
import { reserveAsPatient } from "../../src/modules/site/booking-service.js";
import { localAt } from "./helpers/app.js";
import {
  clearTables,
  createAppointment as insertAppointment,
  createDependent,
  createDoctor,
  createPatient,
  createPublishedSite,
  createTestPool,
  ensurePrivacyDocument,
  resetDatabase,
} from "./helpers/db.js";

// Obligatoria por la constitución (principio III): reservas simultáneas del paciente sin doble reserva.
const pool = createTestPool();
const clock = createFixedClock(new Date("2026-06-15T14:00:00.000Z"));
const deps = { db: pool, clock };
const MX = "America/Mexico_City";
const TUESDAY = "2026-06-16";

beforeAll(async () => {
  await resetDatabase(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  await ensurePrivacyDocument(pool);
});

afterAll(async () => {
  await pool.end();
});

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

async function setupDoctor(): Promise<{ doctorId: number; staff: StaffContext }> {
  const doctor = await createDoctor(pool);
  await createPublishedSite(pool, doctor);
  return { doctorId: doctor.doctorId, staff: createTenantContext(doctor.doctorId, { kind: "doctor", userId: doctor.user.id }) };
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

describe("reservas simultáneas del paciente", () => {
  it("20 reservas simultáneas del mismo horario por pacientes distintos: una cita y 19 slot_unavailable", async () => {
    const { doctorId } = await setupDoctor();
    const patients = await Promise.all(Array.from({ length: 20 }, () => createPatient(pool)));
    const results = await Promise.allSettled(
      patients.map((patient) =>
        reserveAsPatient(createPatientContext(doctorId, patient.user.id), deps, { startLocal: `${TUESDAY}T10:00`, patientId: patient.patientId, authorize: true }),
      ),
    );
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(19);
    expect(rejected.every((result) => result.reason instanceof ConflictError && (result.reason as ConflictError).code === "slot_unavailable")).toBe(true);

    expect(await rows("SELECT id FROM appointment WHERE doctor_id = ? AND status = 'booked'", [doctorId])).toHaveLength(1);
    // Los rechazados no dejan autorización, vínculo ni acción registrada.
    expect(await rows("SELECT id FROM data_authorization")).toHaveLength(1);
    expect(await rows("SELECT id FROM doctor_patient")).toHaveLength(1);
    expect(await rows("SELECT id FROM calendar_action_log WHERE action = 'appointment_created'")).toHaveLength(1);
  });

  it("la misma cuenta enviando el mismo horario 20 veces a la vez deja una cita (doble envío)", async () => {
    const { doctorId } = await setupDoctor();
    const patient = await createPatient(pool);
    const ctx = createPatientContext(doctorId, patient.user.id);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => reserveAsPatient(ctx, deps, { startLocal: `${TUESDAY}T10:00`, patientId: patient.patientId, authorize: true })),
    );
    expect(results.filter((result) => result.status === "rejected")).toEqual([]);
    const created = results.filter((result) => result.status === "fulfilled" && result.value.created);
    expect(created).toHaveLength(1);
    expect(new Set(results.map((result) => (result.status === "fulfilled" ? result.value.id : 0))).size).toBe(1);
    expect(await rows("SELECT id FROM appointment WHERE status = 'booked'")).toHaveLength(1);
    expect(await rows("SELECT id FROM data_authorization")).toHaveLength(1);
  });

  it("reservar contra un bloqueo del médico (20 rondas): nunca hay una cita dentro de un bloqueo", async () => {
    const { doctorId, staff } = await setupDoctor();
    const days = businessDays(20);
    let bothWon = 0;
    for (const [round, date] of days.entries()) {
      const patient = await createPatient(pool);
      const ctx = createPatientContext(doctorId, patient.user.id);
      const [reservation, block] = await Promise.allSettled([
        reserveAsPatient(ctx, deps, { startLocal: `${date}T10:00`, patientId: patient.patientId, authorize: true }),
        blockSlot(staff, deps, `${date}T10:00`),
      ]);
      if (reservation.status === "rejected") expect(reservation.reason).toBeInstanceOf(ConflictError);
      if (block.status === "rejected") expect(block.reason).toBeInstanceOf(BlockConflictError);
      // Exactamente una de las dos gana el espacio.
      if (reservation.status === "fulfilled" && block.status === "fulfilled") bothWon += 1;
      expect(reservation.status === "fulfilled" || block.status === "fulfilled", `ronda ${round}`).toBe(true);
    }
    expect(bothWon).toBe(0);
    const inside = await rows(
      `SELECT COUNT(*) AS n FROM appointment a JOIN calendar_block b ON b.doctor_id = a.doctor_id
        WHERE a.doctor_id = ? AND a.status = 'booked' AND a.start_utc < b.end_utc AND a.end_utc > b.start_utc`,
      [doctorId],
    );
    expect(Number(inside[0]?.n)).toBe(0);
  });

  it("reservar contra la cancelación del personal sobre el mismo horario: a lo sumo una cita vigente y sin pérdidas", async () => {
    const { doctorId, staff } = await setupDoctor();
    const owner = await createPatient(pool);
    const days = businessDays(10);
    const ids: number[] = [];
    for (const date of days) ids.push(await insertAppointment(pool, { doctorId, patientId: owner.patientId, startUtc: localAt(MX, date, "10:00") }));
    for (const [index, date] of days.entries()) {
      const patient = await createPatient(pool);
      const ctx = createPatientContext(doctorId, patient.user.id);
      await Promise.allSettled([
        reserveAsPatient(ctx, deps, { startLocal: `${date}T10:00`, patientId: patient.patientId, authorize: true }),
        cancelAppointment(staff, { ...deps, ticketSecret: "s".repeat(40) }, ids[index] ?? 0),
      ]);
      const booked = await rows("SELECT id FROM appointment WHERE doctor_id = ? AND status = 'booked' AND start_utc = ?", [doctorId, localAt(MX, date, "10:00")]);
      expect(booked.length).toBeLessThanOrEqual(1);
    }
  });

  it("una ráfaga de 8 reservas de la misma cuenta deja pasar exactamente 5 (el límite por hora no se elude)", async () => {
    const { doctorId } = await setupDoctor();
    const patient = await createPatient(pool);
    const second = await createDependent(pool, patient.accountId, "Hijo Uno");
    const third = await createDependent(pool, patient.accountId, "Hijo Dos");
    const ids = [patient.patientId, second, third];
    const ctx = createPatientContext(doctorId, patient.user.id);
    const slots = ["10:00", "11:00", "12:00", "13:00", "16:00", "17:00", "18:00", "09:00"];
    const results = await Promise.allSettled(
      slots.map((time, index) => reserveAsPatient(ctx, deps, { startLocal: `${TUESDAY}T${time}`, patientId: ids[index % 3] ?? 0, authorize: true })),
    );
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(fulfilled).toHaveLength(5);
    expect(rejected).toHaveLength(3);
    expect(rejected.every((result) => result.reason instanceof TooManyAttemptsError)).toBe(true);
    expect(await rows("SELECT id FROM appointment WHERE status = 'booked'")).toHaveLength(5);
  });
});
