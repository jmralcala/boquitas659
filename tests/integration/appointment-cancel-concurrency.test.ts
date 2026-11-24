import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictError } from "../../src/http/errors.js";
import { createTenantContext, type StaffContext } from "../../src/lib/tenant.js";
import { addLocalDays } from "../../src/lib/zoned-time.js";
import { cancelAppointment, createAppointment } from "../../src/modules/calendar/appointment-service.js";
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
import { createTestApp, localAt, type TestApp } from "./helpers/app.js";

// Obligatoria por la constitución (principio III): cancelar y reservar a la vez no pueden dejar el calendario inconsistente.
const pool = createTestPool();
let t: TestApp;
const MX = "America/Mexico_City";
const NOW = new Date("2026-06-15T14:00:00.000Z");

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  t.clock.set(NOW);
  (t.transport.sent as unknown[]).length = 0;
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

const deps = () => ({ db: pool, clock: t.clock, ticketSecret: "s".repeat(40) });

async function setup(patients = 2): Promise<{ ctx: StaffContext; doctorId: number; patientIds: number[] }> {
  const doctor = await createDoctor(pool);
  await createCalendarSettings(pool, doctor.doctorId);
  await createCalendarHours(pool, doctor.doctorId, WEEKDAY_HOURS);
  const patientIds: number[] = [];
  for (let index = 0; index < patients; index += 1) {
    const patient = await createPatient(pool);
    await linkPatientToDoctor(pool, doctor.doctorId, patient.patientId);
    patientIds.push(patient.patientId);
  }
  return { ctx: createTenantContext(doctor.doctorId, { kind: "doctor", userId: doctor.user.id }), doctorId: doctor.doctorId, patientIds };
}

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

describe("cancelar y reservar a la vez", () => {
  it("20 rondas de cancelar la cita vigente mientras otra persona intenta agendar el mismo espacio: nunca dos vigentes", async () => {
    const s = await setup();
    const [first] = s.patientIds as [number, number];
    // Días hábiles consecutivos de martes a viernes, repetidos en semanas distintas: 20 espacios distintos a las 10:00.
    const dates: string[] = [];
    for (let day = 1; dates.length < 20; day += 1) {
      const date = addLocalDays("2026-06-15", day);
      const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
      if (weekday >= 1 && weekday <= 5) dates.push(date);
    }

    let createdAfterCancel = 0;
    let createRejected = 0;
    for (const date of dates) {
      const roundPatient = await createPatient(pool);
      await linkPatientToDoctor(pool, s.doctorId, roundPatient.patientId);
      const existing = await insertAppointment(pool, { doctorId: s.doctorId, patientId: first, startUtc: localAt(MX, date, "10:00") });
      const [cancelResult, createResult] = await Promise.allSettled([
        cancelAppointment(s.ctx, deps(), existing),
        createAppointment(s.ctx, deps(), { startLocal: `${date}T10:00`, patientId: roundPatient.patientId }),
      ]);
      // La cancelación siempre prospera (la cita estaba vigente y futura).
      expect(cancelResult.status).toBe("fulfilled");
      // La creación gana (si la cancelación fue primero) o recibe un conflicto (si la cita aún estaba vigente); nada más.
      if (createResult.status === "fulfilled") createdAfterCancel += 1;
      else {
        createRejected += 1;
        expect(createResult.reason).toBeInstanceOf(ConflictError);
      }
      const booked = await rows(
        "SELECT id FROM appointment WHERE doctor_id = ? AND status = 'booked' AND start_utc = ?",
        [s.doctorId, localAt(MX, date, "10:00")],
      );
      expect(booked.length).toBeLessThanOrEqual(1);
    }
    expect(createdAfterCancel + createRejected).toBe(20);
  });

  it("dos cancelaciones simultáneas de la misma cita: una prospera, la otra recibe conflicto y sale un solo aviso", async () => {
    const s = await setup(1);
    const id = await insertAppointment(pool, { doctorId: s.doctorId, patientId: s.patientIds[0] ?? 0, startUtc: localAt(MX, "2026-06-16", "10:00") });
    const results = await Promise.allSettled([cancelAppointment(s.ctx, deps(), id), cancelAppointment(s.ctx, deps(), id), cancelAppointment(s.ctx, deps(), id)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected).toHaveLength(2);
    expect(rejected.every((result) => result.reason instanceof ConflictError)).toBe(true);
    expect(await rows("SELECT id FROM email_outbox WHERE template = 'appointment_cancelled'")).toHaveLength(1);
    expect(await rows("SELECT id FROM calendar_action_log WHERE action = 'appointment_cancelled'")).toHaveLength(1);
  });

  it("si se cancela antes de enviarse el correo de «agendada», ese correo no sale y solo llega el de cancelación", async () => {
    const s = await setup(1);
    const created = await createAppointment(s.ctx, deps(), { startLocal: "2026-06-16T10:00", patientId: s.patientIds[0] ?? 0 });
    await cancelAppointment(s.ctx, deps(), created.id);

    const result = await t.runOutbox();
    expect(result.cancelled).toBe(1);
    expect(result.sent).toBe(1);
    expect(t.transport.sent.map((message) => message.subject)).toEqual(["Tu cita dental fue cancelada"]);
    expect(await rows("SELECT template, status FROM email_outbox ORDER BY id")).toEqual([
      { template: "appointment_created", status: "cancelled" },
      { template: "appointment_cancelled", status: "sent" },
    ]);
  });

  it("si el correo de «agendada» ya salió, se envía también el de cancelación (en ese orden)", async () => {
    const s = await setup(1);
    const created = await createAppointment(s.ctx, deps(), { startLocal: "2026-06-16T10:00", patientId: s.patientIds[0] ?? 0 });
    await t.runOutbox();
    await cancelAppointment(s.ctx, deps(), created.id);
    await t.runOutbox();
    expect(t.transport.sent.map((message) => message.subject)).toEqual(["Tu cita dental fue agendada", "Tu cita dental fue cancelada"]);
  });
});
