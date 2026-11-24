import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictError, NotFoundError, TooManyAttemptsError } from "../../src/http/errors.js";
import { addLocalDays } from "../../src/lib/zoned-time.js";
import { createPatientContext } from "../../src/lib/tenant.js";
import { reserveAsPatient } from "../../src/modules/site/booking-service.js";
import { cancelAsPatient, listForAccount } from "../../src/modules/site/patient-appointments.js";
import {
  clearTables,
  createAppointment,
  createDependent,
  createDoctor,
  createPatient,
  createPublishedSite,
  createTestPool,
  ensurePrivacyDocument,
  resetDatabase,
  type CreatedDoctor,
  type CreatedPatient,
} from "./helpers/db.js";
import { createTestApp, localAt, type TestApp } from "./helpers/app.js";

const pool = createTestPool();
let t: TestApp;
const MX = "America/Mexico_City";
const NOW = new Date("2026-06-15T14:00:00.000Z"); // lunes 8:00 en Ciudad de México

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  t.clock.set(NOW);
  (t.transport.sent as unknown[]).length = 0;
  t.transport.failNext(0);
  await ensurePrivacyDocument(pool);
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

const deps = () => ({ db: pool, clock: t.clock });

interface Scenario {
  doctor: CreatedDoctor;
  patient: CreatedPatient;
}

async function scenario(options: { cancelNoticeHours?: number; phone?: string; email?: string } = {}): Promise<Scenario> {
  const doctor = await createDoctor(pool, { fullName: "Dra. Elena Ríos" });
  await createPublishedSite(pool, doctor, { settings: { cancelNoticeHours: options.cancelNoticeHours ?? 24 } });
  if (options.phone) await pool.execute("UPDATE doctor SET office_phone = ? WHERE id = ?", [options.phone, doctor.doctorId]);
  const patient = await createPatient(pool, { fullName: "Mario Quintana", email: options.email ?? "mario@example.com" });
  return { doctor, patient };
}

/** Cita agendada por el paciente (inserción directa: no cuenta contra los límites de reserva). */
async function appointmentAt(s: Scenario, date: string, time: string, patientId = s.patient.patientId): Promise<number> {
  return createAppointment(pool, { doctorId: s.doctor.doctorId, patientId, startUtc: localAt(MX, date, time), createdByUserId: s.patient.user.id, createdByRole: "doctor" });
}

describe("cancelAsPatient", () => {
  it("libera el horario, registra quién y cuándo, avisa al médico y envía constancia al paciente", async () => {
    const s = await scenario();
    const id = await appointmentAt(s, "2026-06-17", "10:00");
    await cancelAsPatient(deps(), s.patient.user.id, id);
    const [appointment] = await rows("SELECT status, cancelled_by_user_id, cancelled_by_role, cancelled_at FROM appointment WHERE id = ?", [id]);
    expect(appointment).toMatchObject({ status: "cancelled", cancelled_by_user_id: s.patient.user.id, cancelled_by_role: "patient" });
    expect((appointment?.cancelled_at as Date).toISOString()).toBe(NOW.toISOString());
    expect(await rows("SELECT action, actor_role, appointment_id FROM calendar_action_log")).toEqual([{ action: "appointment_cancelled", actor_role: "patient", appointment_id: id }]);
    expect((await rows("SELECT template, to_email FROM email_outbox ORDER BY id")).map((row) => `${row.template}→${row.to_email}`).sort()).toEqual(
      [`appointment_cancelled_by_patient→mario@example.com`, `doctor_appointment_cancelled→${s.doctor.user.email}`].sort(),
    );
    await t.runOutbox();
    const receipt = t.transport.sent.find((sent) => sent.to === "mario@example.com");
    expect(receipt?.subject).toBe("Cancelaste tu cita dental");
    expect(receipt?.replyTo).toBe(s.doctor.user.email);
    expect(receipt?.text).toContain("10:00");
    const notice = t.transport.sent.find((sent) => sent.to === s.doctor.user.email);
    expect(notice?.subject).toBe("Cita cancelada por el paciente");
    expect(notice?.text).toContain("Mario Quintana");
    expect(notice?.text).not.toContain("5512345678");
    // El horario quedó libre para otra cuenta.
    const other = await createPatient(pool);
    const result = await reserveAsPatient(createPatientContext(s.doctor.doctorId, other.user.id), deps(), { startLocal: "2026-06-17T10:00", patientId: other.patientId, authorize: true });
    expect(result.created).toBe(true);
  });

  it("el borde del límite es inclusivo: justo a las 24 h se permite y un minuto después no", async () => {
    const s = await scenario({ phone: "5598765432" });
    const id = await appointmentAt(s, "2026-06-16", "10:00"); // 16:00Z → límite: lunes 16:00Z
    t.clock.set(new Date("2026-06-15T16:01:00.000Z"));
    const error = await cancelAsPatient(deps(), s.patient.user.id, id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).code).toBe("cancellation_window_closed");
    expect((error as ConflictError).publicMessage).toContain("5598765432");
    expect((await rows("SELECT status FROM appointment WHERE id = ?", [id]))[0]?.status).toBe("booked");
    expect(await rows("SELECT id FROM email_outbox")).toEqual([]);

    t.clock.set(new Date("2026-06-15T16:00:00.000Z"));
    await cancelAsPatient(deps(), s.patient.user.id, id);
    expect((await rows("SELECT status FROM appointment WHERE id = ?", [id]))[0]?.status).toBe("cancelled");
  });

  it("el límite sale de cancel_notice_hours del médico (24 por defecto, otro valor lo cambia)", async () => {
    const s = await scenario({ cancelNoticeHours: 2 });
    const id = await appointmentAt(s, "2026-06-15", "16:00"); // 22:00Z; límite 20:00Z
    t.clock.set(new Date("2026-06-15T19:59:00.000Z"));
    await cancelAsPatient(deps(), s.patient.user.id, id);

    const zero = await scenario({ cancelNoticeHours: 0, email: "cero@example.com" });
    const idZero = await appointmentAt(zero, "2026-06-16", "10:00");
    t.clock.set(new Date("2026-06-16T15:59:00.000Z"));
    await cancelAsPatient(deps(), zero.patient.user.id, idZero);
  });

  it("una cita ya cancelada o ya pasada es un conflicto y no repite avisos", async () => {
    const s = await scenario();
    const cancelled = await createAppointment(pool, { doctorId: s.doctor.doctorId, patientId: s.patient.patientId, startUtc: localAt(MX, "2026-06-18", "10:00"), status: "cancelled", createdByUserId: s.patient.user.id });
    const past = await appointmentAt(s, "2026-06-10", "10:00");
    for (const id of [cancelled, past]) {
      const error = await cancelAsPatient(deps(), s.patient.user.id, id).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).code).toBe("appointment_not_cancelable");
    }
    expect(await rows("SELECT id FROM email_outbox")).toEqual([]);
    expect(await rows("SELECT id FROM calendar_action_log")).toEqual([]);
  });

  it("la cita de otra cuenta o inexistente es NotFoundError y no cambia nada", async () => {
    const s = await scenario();
    const id = await appointmentAt(s, "2026-06-18", "10:00");
    const stranger = await createPatient(pool);
    await expect(cancelAsPatient(deps(), stranger.user.id, id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(cancelAsPatient(deps(), s.patient.user.id, 999999)).rejects.toBeInstanceOf(NotFoundError);
    expect((await rows("SELECT status FROM appointment WHERE id = ?", [id]))[0]?.status).toBe("booked");
  });

  it("puede cancelar la cita de un menor de su cuenta", async () => {
    const s = await scenario();
    const minorId = await createDependent(pool, s.patient.accountId, "Hijo de Mario");
    const id = await appointmentAt(s, "2026-06-18", "10:00", minorId);
    await cancelAsPatient(deps(), s.patient.user.id, id);
    expect((await rows("SELECT status FROM appointment WHERE id = ?", [id]))[0]?.status).toBe("cancelled");
  });

  it("puede cancelar aunque el micrositio esté despublicado o el médico ya no esté aprobado", async () => {
    const s = await scenario();
    const first = await appointmentAt(s, "2026-06-18", "10:00");
    const second = await appointmentAt(s, "2026-06-18", "11:00");
    await pool.execute("UPDATE doctor_site SET status = 'unpublished' WHERE doctor_id = ?", [s.doctor.doctorId]);
    await cancelAsPatient(deps(), s.patient.user.id, first);
    await pool.execute("UPDATE doctor SET approval_status = 'rejected' WHERE id = ?", [s.doctor.doctorId]);
    await cancelAsPatient(deps(), s.patient.user.id, second);
  });

  it("10 cancelaciones por hora por cuenta (de cualquiera de sus pacientes); la 11.ª es 429 y una hora después se permite", async () => {
    const s = await scenario();
    const minorId = await createDependent(pool, s.patient.accountId);
    const days: string[] = [];
    for (let day = 2; days.length < 11; day += 1) {
      const date = addLocalDays("2026-06-15", day);
      if (new Date(`${date}T00:00:00Z`).getUTCDay() % 6 !== 0) days.push(date);
    }
    const ids: number[] = [];
    for (const [index, date] of days.entries()) ids.push(await appointmentAt(s, date, "10:00", index % 2 === 0 ? s.patient.patientId : minorId));
    for (const id of ids.slice(0, 10)) await cancelAsPatient(deps(), s.patient.user.id, id);
    const error = await cancelAsPatient(deps(), s.patient.user.id, ids[10] ?? 0).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TooManyAttemptsError);
    expect((await rows("SELECT status FROM appointment WHERE id = ?", [ids[10]]))[0]?.status).toBe("booked");
    t.clock.set(new Date(NOW.getTime() + 61 * 60_000));
    await cancelAsPatient(deps(), s.patient.user.id, ids[10] ?? 0);
  });
});

describe("cancelAsPatient: concurrencia", () => {
  it("tres cancelaciones simultáneas de la misma cita: una prospera, las demás conflicto y un solo aviso", async () => {
    const s = await scenario();
    const id = await appointmentAt(s, "2026-06-18", "10:00");
    const results = await Promise.allSettled([1, 2, 3].map(() => cancelAsPatient(deps(), s.patient.user.id, id)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected).toHaveLength(2);
    expect(rejected.every((result) => result.reason instanceof ConflictError)).toBe(true);
    expect(await rows("SELECT id FROM email_outbox WHERE template = 'appointment_cancelled_by_patient'")).toHaveLength(1);
    expect(await rows("SELECT id FROM email_outbox WHERE template = 'doctor_appointment_cancelled'")).toHaveLength(1);
    expect(await rows("SELECT id FROM calendar_action_log WHERE action = 'appointment_cancelled'")).toHaveLength(1);
  });

  it("cancelar y reservar el mismo horario a la vez deja como máximo una cita vigente", async () => {
    const s = await scenario();
    const other = await createPatient(pool);
    for (const [index, date] of ["2026-06-18", "2026-06-19", "2026-06-22", "2026-06-23", "2026-06-24"].entries()) {
      const id = await appointmentAt(s, date, "10:00");
      await Promise.allSettled([
        cancelAsPatient(deps(), s.patient.user.id, id),
        reserveAsPatient(createPatientContext(s.doctor.doctorId, other.user.id), deps(), { startLocal: `${date}T10:00`, patientId: other.patientId, authorize: true }),
      ]);
      const booked = await rows("SELECT id FROM appointment WHERE doctor_id = ? AND status = 'booked' AND start_utc = ?", [s.doctor.doctorId, localAt(MX, date, "10:00")]);
      expect(booked.length, `ronda ${index}`).toBeLessThanOrEqual(1);
    }
  });
});

describe("listForAccount", () => {
  it("muestra solo las citas de las personas de la cuenta, de cualquier consultorio, próximas y de los últimos 90 días", async () => {
    const s = await scenario();
    const otherDoctor = await createDoctor(pool, { fullName: "Dr. Otro Consultorio" });
    await createPublishedSite(pool, otherDoctor, { slug: "otro-consultorio" });
    const minorId = await createDependent(pool, s.patient.accountId, "Hijo de Mario");
    const stranger = await createPatient(pool, { fullName: "Persona Ajena" });

    const mine = await appointmentAt(s, "2026-06-18", "10:00");
    const minors = await appointmentAt(s, "2026-06-18", "11:00", minorId);
    const elsewhere = await createAppointment(pool, { doctorId: otherDoctor.doctorId, patientId: s.patient.patientId, startUtc: localAt(MX, "2026-06-19", "10:00") });
    await createAppointment(pool, { doctorId: s.doctor.doctorId, patientId: stranger.patientId, startUtc: localAt(MX, "2026-06-18", "12:00") });
    const recent = await appointmentAt(s, "2026-06-10", "10:00");
    const old = await createAppointment(pool, { doctorId: s.doctor.doctorId, patientId: s.patient.patientId, startUtc: new Date(NOW.getTime() - 91 * 86_400_000) });

    const result = await listForAccount(pool, s.patient.user.id, t.clock.now());
    expect(result.upcoming.map((item) => item.id)).toEqual([mine, minors, elsewhere]);
    expect(result.history.map((item) => item.id)).toEqual([recent]);
    expect([...result.upcoming, ...result.history].map((item) => item.id)).not.toContain(old);
    const first = result.upcoming[0];
    expect(first).toMatchObject({ doctorName: "Dra. Elena Ríos", patientName: "Mario Quintana", status: "booked", cancelable: true });
    expect(result.upcoming[1]?.patientName).toBe("Hijo de Mario");
    expect(JSON.stringify(result)).not.toContain("Persona Ajena");
  });

  it("una cita cancelada aparece en el historial y una dentro del límite aparece como no cancelable", async () => {
    const s = await scenario({ phone: "5598765432" });
    const soon = await appointmentAt(s, "2026-06-16", "10:00");
    const cancelled = await createAppointment(pool, { doctorId: s.doctor.doctorId, patientId: s.patient.patientId, startUtc: localAt(MX, "2026-06-19", "10:00"), status: "cancelled", createdByUserId: s.patient.user.id });
    t.clock.set(new Date("2026-06-15T17:00:00.000Z")); // ya pasó el límite de la cita del martes
    const result = await listForAccount(pool, s.patient.user.id, t.clock.now());
    expect(result.upcoming.find((item) => item.id === soon)).toMatchObject({ cancelable: false, officePhone: "5598765432" });
    expect(result.history.find((item) => item.id === cancelled)?.status).toBe("cancelled");
  });
});
