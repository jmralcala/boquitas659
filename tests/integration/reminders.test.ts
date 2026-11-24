import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { enqueueDueReminders } from "../../src/jobs/reminders-service.js";
import {
  clearTables,
  createAppointment,
  createDoctor,
  createPatient,
  createPublishedSite,
  createTestPool,
  resetDatabase,
  type CreatedDoctor,
  type CreatedPatient,
} from "./helpers/db.js";
import { createTestApp, type TestApp } from "./helpers/app.js";

const pool = createTestPool();
let t: TestApp;
const NOW = new Date("2026-06-15T14:00:00.000Z");
const HOUR = 3_600_000;

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  t.clock.set(NOW);
  (t.transport.sent as unknown[]).length = 0;
  t.transport.failNext(0);
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

interface Scenario {
  doctor: CreatedDoctor;
  patient: CreatedPatient;
}

async function scenario(cancelNoticeHours = 24): Promise<Scenario> {
  const doctor = await createDoctor(pool, { fullName: "Dra. Elena Ríos" });
  await createPublishedSite(pool, doctor, { settings: { cancelNoticeHours } });
  const patient = await createPatient(pool, { fullName: "Mario Quintana", email: "mario@example.com" });
  return { doctor, patient };
}

/** Cita que empieza dentro de `hoursAhead` horas, creada con tiempo (hace 4 días) salvo que se indique otra cosa. */
function appointmentIn(s: Scenario, hoursAhead: number, extra: { status?: "booked" | "cancelled"; createdAt?: Date; createdByRole?: "doctor" | "patient"; kind?: "regular" | "urgent" } = {}): Promise<number> {
  return createAppointment(pool, {
    doctorId: s.doctor.doctorId,
    patientId: s.patient.patientId,
    startUtc: new Date(NOW.getTime() + hoursAhead * HOUR),
    createdAt: extra.createdAt ?? new Date(NOW.getTime() - 96 * HOUR),
    ...(extra.status ? { status: extra.status } : {}),
    ...(extra.createdByRole ? { createdByRole: extra.createdByRole } : {}),
    ...(extra.kind ? { kind: extra.kind } : {}),
  });
}

const reminders = () => rows("SELECT id, payload_ref FROM email_outbox WHERE template = 'appointment_reminder'");

describe("enqueueDueReminders", () => {
  it("una cita a 30 h o menos recibe UN recordatorio aunque la tarea corra varias veces", async () => {
    const s = await scenario();
    const id = await appointmentIn(s, 29);
    expect(await enqueueDueReminders(pool, t.clock)).toBe(1);
    expect(await enqueueDueReminders(pool, t.clock)).toBe(0);
    expect(await enqueueDueReminders(pool, t.clock)).toBe(0);
    const queued = await reminders();
    expect(queued).toHaveLength(1);
    expect(JSON.parse(String(queued[0]?.payload_ref))).toEqual({ appointmentId: id });
    const [appointment] = await rows("SELECT reminder_enqueued_at FROM appointment WHERE id = ?", [id]);
    expect((appointment?.reminder_enqueued_at as Date).toISOString()).toBe(NOW.toISOString());
  });

  it("dos procesos a la vez no duplican el recordatorio", async () => {
    const s = await scenario();
    await appointmentIn(s, 20);
    await Promise.all(Array.from({ length: 6 }, () => enqueueDueReminders(pool, t.clock)));
    expect(await reminders()).toHaveLength(1);
  });

  it("no se envía antes de su momento: a 31 h todavía no, una hora después sí", async () => {
    const s = await scenario();
    await appointmentIn(s, 31);
    expect(await enqueueDueReminders(pool, t.clock)).toBe(0);
    t.clock.advance(HOUR);
    expect(await enqueueDueReminders(pool, t.clock)).toBe(1);
  });

  it("no se encola para citas canceladas, ya iniciadas o reservadas con menos anticipación que el momento del recordatorio", async () => {
    const s = await scenario();
    await appointmentIn(s, 20, { status: "cancelled" });
    await appointmentIn(s, -1); // ya empezó
    await appointmentIn(s, 10, { createdAt: new Date(NOW.getTime() - 5 * 60_000) }); // reservada hace 5 min: la confirmación basta
    expect(await enqueueDueReminders(pool, t.clock)).toBe(0);
    expect(await reminders()).toEqual([]);
  });

  it("una urgencia nunca recibe recordatorio (ni su «plazo para cancelar»), aunque cumpla el momento", async () => {
    const s = await scenario();
    await appointmentIn(s, 29, { kind: "urgent", createdByRole: "patient" });
    expect(await enqueueDueReminders(pool, t.clock)).toBe(0);
    expect(await reminders()).toEqual([]);
    expect((await rows("SELECT reminder_enqueued_at FROM appointment"))[0]?.reminder_enqueued_at).toBeNull();
  });

  it("con límite de 48 h el recordatorio sale 54 h antes", async () => {
    const s = await scenario(48);
    await appointmentIn(s, 55);
    expect(await enqueueDueReminders(pool, t.clock)).toBe(0);
    await appointmentIn(s, 53);
    expect(await enqueueDueReminders(pool, t.clock)).toBe(1);
  });

  it("cambiar el límite recalcula los recordatorios futuros", async () => {
    const s = await scenario(24);
    await appointmentIn(s, 40);
    expect(await enqueueDueReminders(pool, t.clock)).toBe(0);
    await pool.execute("UPDATE calendar_settings SET cancel_notice_hours = 48 WHERE doctor_id = ?", [s.doctor.doctorId]);
    expect(await enqueueDueReminders(pool, t.clock)).toBe(1);
  });

  it("las citas del personal también reciben recordatorio", async () => {
    const s = await scenario();
    await appointmentIn(s, 25, { createdByRole: "doctor" });
    expect(await enqueueDueReminders(pool, t.clock)).toBe(1);
  });

  it("procesa por lotes sin repetir", async () => {
    const s = await scenario();
    for (let index = 0; index < 5; index += 1) await appointmentIn(s, 10 + index);
    expect(await enqueueDueReminders(pool, t.clock, 2)).toBe(2);
    expect(await enqueueDueReminders(pool, t.clock, 2)).toBe(2);
    expect(await enqueueDueReminders(pool, t.clock, 2)).toBe(1);
    expect(await reminders()).toHaveLength(5);
  });
});

describe("correo appointment_reminder", () => {
  it("llega a la cuenta con médico, fecha, dirección, teléfono, plazo para cancelar, enlace y Reply-To", async () => {
    const s = await scenario();
    await appointmentIn(s, 29);
    await enqueueDueReminders(pool, t.clock);
    await t.runOutbox();
    const message = t.transport.sent.find((sent) => sent.to === "mario@example.com");
    expect(message?.subject).toBe("Recordatorio de tu cita dental");
    expect(message?.replyTo).toBe(s.doctor.user.email);
    expect(message?.text).toContain("Dra. Elena Ríos");
    expect(message?.text).toContain("Mario Quintana");
    expect(message?.text).toContain("Calle Falsa 123, Centro");
    expect(message?.text).toContain("5598765432");
    expect(message?.text).toContain("Puedes cancelar hasta");
    expect(message?.text).toMatch(/https?:\/\/\S+\/citas\/enlace\/\S+/);
  });

  it("su token (propósito appointment_reminder) no invalida el de la confirmación", async () => {
    const s = await scenario();
    const id = await appointmentIn(s, 29);
    const confirmation = await t.services.tokens.create({ purpose: "appointment_confirmation", appointmentId: id, ttlMs: 86_400_000 });
    await enqueueDueReminders(pool, t.clock);
    await t.runOutbox();
    expect(await rows("SELECT purpose FROM one_time_token ORDER BY purpose")).toEqual([{ purpose: "appointment_confirmation" }, { purpose: "appointment_reminder" }]);
    expect((await t.services.links.resolve(confirmation.token, null)).kind).toBe("login_required");
  });

  it("si la cita se cancela entre el encolado y el envío, el correo se cancela", async () => {
    const s = await scenario();
    const id = await appointmentIn(s, 29);
    await enqueueDueReminders(pool, t.clock);
    await pool.execute("UPDATE appointment SET status = 'cancelled', cancelled_at = ? WHERE id = ?", [NOW, id]);
    await t.runOutbox();
    expect(t.transport.sent).toEqual([]);
    expect(await rows("SELECT status FROM email_outbox WHERE template = 'appointment_reminder'")).toEqual([{ status: "cancelled" }]);
  });

  it("el procesamiento del outbox no genera recordatorios: solo el job de recordatorios", async () => {
    const s = await scenario();
    await appointmentIn(s, 29);
    await t.runOutbox();
    expect(await reminders()).toEqual([]);
    expect((await rows("SELECT reminder_enqueued_at FROM appointment"))[0]?.reminder_enqueued_at).toBeNull();
  });
});
