import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictError } from "../../src/http/errors.js";
import { createFixedClock } from "../../src/lib/clock.js";
import { createTenantContext, type StaffContext } from "../../src/lib/tenant.js";
import { createAppointment } from "../../src/modules/calendar/appointment-service.js";
import {
  clearTables,
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

// Esta prueba es obligatoria por la constitución (principio III): «Debe existir una prueba automática de reservas simultáneas».
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
});

afterAll(async () => {
  await pool.end();
});

async function doctorWithPatients(patients: number): Promise<{ ctx: StaffContext; doctorId: number; userId: number; patientIds: number[] }> {
  const doctor = await createDoctor(pool);
  await createCalendarSettings(pool, doctor.doctorId);
  await createCalendarHours(pool, doctor.doctorId, WEEKDAY_HOURS);
  const patientIds: number[] = [];
  for (let index = 0; index < patients; index += 1) {
    const patient = await createPatient(pool);
    await linkPatientToDoctor(pool, doctor.doctorId, patient.patientId);
    patientIds.push(patient.patientId);
  }
  return { ctx: createTenantContext(doctor.doctorId, { kind: "doctor", userId: doctor.user.id }), doctorId: doctor.doctorId, userId: doctor.user.id, patientIds };
}

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

describe("reservas simultáneas", () => {
  it("20 creaciones simultáneas del mismo espacio: exactamente una cita vigente y 19 conflictos", async () => {
    const s = await doctorWithPatients(20);
    const results = await Promise.allSettled(
      s.patientIds.map((patientId) => createAppointment(s.ctx, deps, { startLocal: `${TUESDAY}T10:00`, patientId })),
    );
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(19);
    expect(rejected.every((result) => result.reason instanceof ConflictError)).toBe(true);

    expect(await rows("SELECT id FROM appointment WHERE doctor_id = ? AND status = 'booked'", [s.doctorId])).toHaveLength(1);
    // Un solo aviso: los rechazados no dejan correo.
    expect(await rows("SELECT id FROM email_outbox")).toHaveLength(1);
    expect(await rows("SELECT id FROM calendar_action_log WHERE action = 'appointment_created'")).toHaveLength(1);
  });

  it("el mismo paciente intentando agendar el mismo espacio 20 veces a la vez también deja una sola cita", async () => {
    const s = await doctorWithPatients(1);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => createAppointment(s.ctx, deps, { startLocal: `${TUESDAY}T10:00`, patientId: s.patientIds[0] ?? 0 })),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await rows("SELECT id FROM appointment WHERE status = 'booked'")).toHaveLength(1);
  });

  it("el índice único rechaza una segunda cita vigente con el mismo inicio aunque se salte el servicio", async () => {
    const s = await doctorWithPatients(2);
    await createAppointment(s.ctx, deps, { startLocal: `${TUESDAY}T10:00`, patientId: s.patientIds[0] ?? 0 });
    const start = localAt(MX, TUESDAY, "10:00");
    await expect(
      pool.execute(
        `INSERT INTO appointment (doctor_id, patient_id, start_utc, end_utc, created_by_user_id, created_by_role, created_at)
         VALUES (?, ?, ?, ?, ?, 'doctor', UTC_TIMESTAMP(3))`,
        [s.doctorId, s.patientIds[1] ?? 0, start, new Date(start.getTime() + 45 * 60_000), s.userId],
      ),
    ).rejects.toMatchObject({ errno: 1062 });
  });

  it("espacios distintos del mismo médico, a la vez: todos prosperan", async () => {
    const s = await doctorWithPatients(5);
    const starts = ["09:00", "10:00", "11:00", "12:00", "13:00"];
    const results = await Promise.allSettled(
      starts.map((time, index) => createAppointment(s.ctx, deps, { startLocal: `${TUESDAY}T${time}`, patientId: s.patientIds[index] ?? 0 })),
    );
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(await rows("SELECT id FROM appointment WHERE status = 'booked'")).toHaveLength(5);
  });

  it("dos médicos con el mismo espacio, a la vez: ambos prosperan (no se bloquean entre sí)", async () => {
    const a = await doctorWithPatients(1);
    const b = await doctorWithPatients(1);
    const results = await Promise.allSettled([
      createAppointment(a.ctx, deps, { startLocal: `${TUESDAY}T10:00`, patientId: a.patientIds[0] ?? 0 }),
      createAppointment(b.ctx, deps, { startLocal: `${TUESDAY}T10:00`, patientId: b.patientIds[0] ?? 0 }),
    ]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
  });

  it("espacios que se solapan (duración reducida) pedidos a la vez: solo uno prospera", async () => {
    const s = await doctorWithPatients(2);
    await pool.execute("UPDATE calendar_settings SET slot_minutes = 30, gap_minutes = 0 WHERE doctor_id = ?", [s.doctorId]);
    // Cita antigua de 45 min a las 10:00; los espacios nuevos de 10:00 y 10:30 se solapan con ella y entre sí por orden.
    const results = await Promise.allSettled([
      createAppointment(s.ctx, deps, { startLocal: `${TUESDAY}T10:00`, patientId: s.patientIds[0] ?? 0 }),
      createAppointment(s.ctx, deps, { startLocal: `${TUESDAY}T10:00`, patientId: s.patientIds[1] ?? 0 }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });
});
