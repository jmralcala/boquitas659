import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFixedClock } from "../../src/lib/clock.js";
import { createPatientContext, createTenantContext } from "../../src/lib/tenant.js";
import { cancelAppointment } from "../../src/modules/calendar/appointment-service.js";
import { BlockConflictError, blockSlot } from "../../src/modules/calendar/block-service.js";
import { reserveAsPatient } from "../../src/modules/site/booking-service.js";
import { requestUrgent, type UrgentResult } from "../../src/modules/urgent/urgent-service.js";
import {
  clearTables,
  createAppointment,
  createDoctor,
  createPatient,
  createPublishedSite,
  createTestPool,
  ensurePrivacyDocument,
  resetDatabase,
  type CreatedDoctor,
} from "./helpers/db.js";
import { localAt } from "./helpers/app.js";

// Obligatoria por la constitución (principios III y V): solicitudes simultáneas de urgencia sin doble reserva.
const pool = createTestPool();
const clock = createFixedClock(new Date("2026-06-15T14:00:00.000Z")); // lunes 8:00 en Ciudad de México
const deps = { db: pool, clock };
const MX = "America/Mexico_City";
const MONDAY = "2026-06-15";
const URGENT = (start: number, end: number) => [{ weekday: 1, startMinute: start, endMinute: end, kind: "urgent" as const }];

beforeAll(async () => {
  await resetDatabase(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  clock.set(new Date("2026-06-15T14:00:00.000Z"));
  await ensurePrivacyDocument(pool);
});

afterAll(async () => {
  await pool.end();
});

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

/** Médico con SOLO las franjas indicadas (sin horario convencional adicional). */
async function doctorWith(hours: NonNullable<NonNullable<Parameters<typeof createPublishedSite>[2]>["hours"]>): Promise<CreatedDoctor> {
  const doctor = await createDoctor(pool);
  await createPublishedSite(pool, doctor, { hours });
  return doctor;
}

async function patients(count: number) {
  return Promise.all(Array.from({ length: count }, () => createPatient(pool)));
}

const urgentFor = (doctorId: number, patient: Awaited<ReturnType<typeof createPatient>>): Promise<UrgentResult> =>
  requestUrgent(createPatientContext(doctorId, patient.user.id), deps, { patientId: patient.patientId, category: "rojo", authorize: true });

const bookedAt = (doctorId: number, time: string) =>
  rows("SELECT id, kind FROM appointment WHERE doctor_id = ? AND status = 'booked' AND start_utc = ?", [doctorId, localAt(MX, MONDAY, time)]);

describe("urgencias simultáneas", () => {
  it("20 solicitudes de pacientes distintos con UN solo espacio libre: exactamente una cita y 19 «sin espacio»", async () => {
    const doctor = await doctorWith(URGENT(10 * 60, 10 * 60 + 45)); // un solo espacio: lunes 10:00
    const group = await patients(20);
    const results = await Promise.allSettled(group.map((patient) => urgentFor(doctor.doctorId, patient)));
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    const values = results.map((result) => (result.status === "fulfilled" ? result.value : null));
    expect(values.filter((value) => value?.kind === "scheduled")).toHaveLength(1);
    expect(values.filter((value) => value?.kind === "no_space")).toHaveLength(19);
    expect(await bookedAt(doctor.doctorId, "10:00")).toHaveLength(1);
    expect(await rows("SELECT id FROM appointment WHERE doctor_id = ? AND status = 'booked'", [doctor.doctorId])).toHaveLength(1);
    // Los rechazados no dejan cita, vínculo ni autorización; solo la que agendó.
    expect(await rows("SELECT id FROM data_authorization")).toHaveLength(1);
    expect(await rows("SELECT id FROM doctor_patient")).toHaveLength(1);
    expect(await rows("SELECT id FROM calendar_action_log WHERE action = 'urgent_requested' AND outcome = 'ok'")).toHaveLength(1);
  });

  it("con dos espacios libres en la ventana se agendan dos citas y las demás quedan sin espacio", async () => {
    const doctor = await doctorWith(URGENT(10 * 60, 12 * 60)); // 10:00 y 11:00
    const group = await patients(12);
    const results = await Promise.all(group.map((patient) => requestUrgent(createPatientContext(doctor.doctorId, patient.user.id), deps, { patientId: patient.patientId, category: "naranja", authorize: true })));
    expect(results.filter((result) => result.kind === "scheduled")).toHaveLength(2);
    expect(results.filter((result) => result.kind === "no_space")).toHaveLength(10);
    const starts = await rows("SELECT start_utc FROM appointment WHERE doctor_id = ? AND status = 'booked' ORDER BY start_utc", [doctor.doctorId]);
    expect(starts.map((row) => (row.start_utc as Date).toISOString())).toEqual([localAt(MX, MONDAY, "10:00").toISOString(), localAt(MX, MONDAY, "11:00").toISOString()]);
  });

  it("el mismo paciente enviando 20 veces a la vez con un solo espacio: una sola cita", async () => {
    const doctor = await doctorWith(URGENT(10 * 60, 10 * 60 + 45));
    const [patient] = await patients(1);
    if (!patient) throw new Error("sin paciente");
    const results = await Promise.all(Array.from({ length: 20 }, () => urgentFor(doctor.doctorId, patient)));
    // Una crea la cita; las demás son doble envío (devuelven esa misma cita) o, si llegaron antes, quedan sin espacio.
    expect(results.filter((result) => result.kind === "scheduled" && result.created)).toHaveLength(1);
    expect(new Set(results.filter((result) => result.kind === "scheduled").map((result) => (result.kind === "scheduled" ? result.id : 0))).size).toBe(1);
    expect(await bookedAt(doctor.doctorId, "10:00")).toHaveLength(1);
  });

  it("urgencia contra un bloqueo del médico sobre el único espacio (20 rondas): nunca una cita dentro de un bloqueo", async () => {
    let urgentWon = 0;
    let blockWon = 0;
    for (let round = 0; round < 20; round += 1) {
      const doctor = await doctorWith(URGENT(10 * 60, 10 * 60 + 45));
      const [patient] = await patients(1);
      if (!patient) throw new Error("sin paciente");
      const staff = createTenantContext(doctor.doctorId, { kind: "doctor", userId: doctor.user.id });
      const [urgent, block] = await Promise.allSettled([urgentFor(doctor.doctorId, patient), blockSlot(staff, deps, `${MONDAY}T10:00`)]);
      if (block.status === "rejected") expect(block.reason).toBeInstanceOf(BlockConflictError);
      expect(urgent.status, `ronda ${round}`).toBe("fulfilled");
      const scheduled = urgent.status === "fulfilled" && urgent.value.kind === "scheduled";
      // Exactamente una de las dos gana el espacio.
      expect(scheduled !== (block.status === "fulfilled"), `ronda ${round}`).toBe(true);
      if (scheduled) urgentWon += 1;
      else blockWon += 1;
      const inside = await rows(
        `SELECT COUNT(*) AS n FROM appointment a JOIN calendar_block b ON b.doctor_id = a.doctor_id
          WHERE a.doctor_id = ? AND a.status = 'booked' AND a.start_utc < b.end_utc AND a.end_utc > b.start_utc`,
        [doctor.doctorId],
      );
      expect(Number(inside[0]?.n)).toBe(0);
    }
    expect(urgentWon + blockWon).toBe(20);
  });

  it("urgencia contra una reserva convencional del mismo espacio (10 rondas): una gana y nunca hay dos citas", async () => {
    for (let round = 0; round < 10; round += 1) {
      // Un solo espacio regular: lunes 10:00 (el paciente lo reserva con su anticipación mínima de 2 h: justo en el borde).
      const doctor = await doctorWith([{ weekday: 1, startMinute: 10 * 60, endMinute: 10 * 60 + 45 }]);
      const [urgentPatient, regularPatient] = await patients(2);
      if (!urgentPatient || !regularPatient) throw new Error("sin pacientes");
      const [urgent, regular] = await Promise.allSettled([
        urgentFor(doctor.doctorId, urgentPatient),
        reserveAsPatient(createPatientContext(doctor.doctorId, regularPatient.user.id), deps, { startLocal: `${MONDAY}T10:00`, patientId: regularPatient.patientId, authorize: true }),
      ]);
      expect(urgent.status).toBe("fulfilled");
      const urgentScheduled = urgent.status === "fulfilled" && urgent.value.kind === "scheduled";
      const regularScheduled = regular.status === "fulfilled";
      expect(urgentScheduled !== regularScheduled, `ronda ${round}`).toBe(true);
      expect(await bookedAt(doctor.doctorId, "10:00")).toHaveLength(1);
    }
  });

  it("urgencia contra la cancelación del personal que libera el único espacio (10 rondas): a lo sumo una cita vigente y sin pérdidas", async () => {
    for (let round = 0; round < 10; round += 1) {
      const doctor = await doctorWith([{ weekday: 1, startMinute: 10 * 60, endMinute: 10 * 60 + 45 }]);
      const [owner, urgentPatient] = await patients(2);
      if (!owner || !urgentPatient) throw new Error("sin pacientes");
      const existing = await createAppointment(pool, { doctorId: doctor.doctorId, patientId: owner.patientId, startUtc: localAt(MX, MONDAY, "10:00") });
      const staff = createTenantContext(doctor.doctorId, { kind: "doctor", userId: doctor.user.id });
      const [urgent, cancel] = await Promise.allSettled([urgentFor(doctor.doctorId, urgentPatient), cancelAppointment(staff, { ...deps, ticketSecret: "s".repeat(40) }, existing)]);
      expect(cancel.status, `ronda ${round}`).toBe("fulfilled");
      expect(urgent.status).toBe("fulfilled");
      expect((await bookedAt(doctor.doctorId, "10:00")).length).toBeLessThanOrEqual(1);
      expect((await rows("SELECT status FROM appointment WHERE id = ?", [existing]))[0]?.status).toBe("cancelled");
    }
  });
});
