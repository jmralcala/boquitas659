import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictError, TooManyAttemptsError } from "../../src/http/errors.js";
import { createPatientContext } from "../../src/lib/tenant.js";
import { cancelAsPatient } from "../../src/modules/site/patient-appointments.js";
import { requestUrgent } from "../../src/modules/urgent/urgent-service.js";
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
  type CreatedPatient,
} from "./helpers/db.js";
import { createTestApp, localAt, type TestApp } from "./helpers/app.js";

const pool = createTestPool();
let t: TestApp;
const MX = "America/Mexico_City";
const NOW = new Date("2026-06-15T14:00:00.000Z"); // lunes 8:00 en Ciudad de México
const MINUTE = 60_000;
const URGENT = [{ weekday: 1, startMinute: 10 * 60, endMinute: 12 * 60, kind: "urgent" as const }]; // lunes 10:00 y 11:00

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

interface Scenario {
  doctor: CreatedDoctor;
  patient: CreatedPatient;
}

async function scenario(email = "mario@example.com"): Promise<Scenario> {
  const doctor = await createDoctor(pool, { fullName: "Dra. Elena Ríos" });
  await createPublishedSite(pool, doctor, { hours: URGENT, settings: { cancelNoticeHours: 24 } });
  return { doctor, patient: await createPatient(pool, { fullName: "Mario Quintana", email }) };
}

const deps = () => ({ db: pool, clock: t.clock });

async function urgent(s: Scenario, patient = s.patient): Promise<number> {
  const result = await requestUrgent(createPatientContext(s.doctor.doctorId, patient.user.id), deps(), { patientId: patient.patientId, category: "rojo", authorize: true });
  if (result.kind !== "scheduled") throw new Error("se esperaba una cita");
  return result.id;
}

describe("cancelar una urgencia", () => {
  it("se permite aunque empiece en menos de 24 h: libera el espacio, registra quién y cuándo y avisa al médico", async () => {
    const s = await scenario();
    const id = await urgent(s); // lunes 10:00, a 2 h: muy dentro del plazo de 24 h
    await cancelAsPatient(deps(), s.patient.user.id, id);
    const [appointment] = await rows("SELECT status, cancelled_by_user_id, cancelled_by_role, cancelled_at, kind FROM appointment WHERE id = ?", [id]);
    expect(appointment).toMatchObject({ status: "cancelled", cancelled_by_user_id: s.patient.user.id, cancelled_by_role: "patient", kind: "urgent" });
    expect((appointment?.cancelled_at as Date).toISOString()).toBe(NOW.toISOString());
    expect(await rows("SELECT action, actor_role, appointment_id FROM calendar_action_log WHERE action = 'appointment_cancelled'")).toEqual([{ action: "appointment_cancelled", actor_role: "patient", appointment_id: id }]);

    await t.runOutbox();
    const notice = t.transport.sent.find((sent) => sent.subject === "Cita cancelada por el paciente");
    expect(notice?.to).toBe(s.doctor.user.email);
    expect(t.transport.sent.find((sent) => sent.subject === "Cancelaste tu cita dental")?.to).toBe("mario@example.com");
    // El aviso de «urgencia agendada» que seguía en cola no sale y no conserva la categoría.
    expect(t.transport.sent.find((sent) => sent.subject === "Nueva urgencia agendada")).toBeUndefined();
    const queued = await rows("SELECT status, payload_ref FROM email_outbox WHERE template = 'doctor_urgent_notice'");
    expect(queued[0]?.status).toBe("cancelled");
    expect(String(queued[0]?.payload_ref)).not.toContain("rojo");
    expect(`${notice?.subject}\n${notice?.text}`.toLowerCase()).not.toMatch(/\b(rojo|naranja|amarillo|verde)\b/);
  });

  it("se permite incluso un minuto antes de empezar", async () => {
    const s = await scenario();
    const id = await urgent(s);
    t.clock.set(new Date(localAt(MX, "2026-06-15", "10:00").getTime() - MINUTE));
    await cancelAsPatient(deps(), s.patient.user.id, id);
    expect((await rows("SELECT status FROM appointment WHERE id = ?", [id]))[0]?.status).toBe("cancelled");
  });

  it("una cita convencional en la misma situación sigue sin poder cancelarse (cancellation_window_closed)", async () => {
    const s = await scenario();
    const regular = await createAppointment(pool, { doctorId: s.doctor.doctorId, patientId: s.patient.patientId, startUtc: localAt(MX, "2026-06-15", "18:00"), createdByUserId: s.patient.user.id, createdByRole: "patient" });
    const error = await cancelAsPatient(deps(), s.patient.user.id, regular).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).code).toBe("cancellation_window_closed");
  });

  it("una urgencia ya iniciada, pasada o ya cancelada da conflicto sin repetir avisos", async () => {
    const s = await scenario();
    const id = await urgent(s);
    t.clock.set(new Date(localAt(MX, "2026-06-15", "10:45").getTime() + MINUTE)); // terminó
    const past = await cancelAsPatient(deps(), s.patient.user.id, id).catch((e: unknown) => e);
    expect(past).toBeInstanceOf(ConflictError);
    expect((past as ConflictError).code).toBe("appointment_not_cancelable");

    t.clock.set(NOW);
    const s2 = await scenario("otro@example.com");
    const id2 = await urgent(s2);
    await cancelAsPatient(deps(), s2.patient.user.id, id2);
    const emails = (await rows("SELECT id FROM email_outbox")).length;
    await expect(cancelAsPatient(deps(), s2.patient.user.id, id2)).rejects.toBeInstanceOf(ConflictError);
    expect(await rows("SELECT id FROM email_outbox")).toHaveLength(emails);
  });

  it("el espacio queda libre de inmediato: otra persona puede pedir la urgencia en ese espacio", async () => {
    const s = await scenario();
    const id = await urgent(s);
    const other = await createPatient(pool);
    // Naranja (ventana de 12 h): el espacio de las 11:00 queda fuera de la ventana de 2 h de Rojo.
    const taken = await requestUrgent(createPatientContext(s.doctor.doctorId, other.user.id), deps(), { patientId: other.patientId, category: "naranja", authorize: true });
    expect(taken.kind === "scheduled" && taken.startUtc.toISOString()).toBe(localAt(MX, "2026-06-15", "11:00").toISOString()); // 10:00 estaba ocupado
    await cancelAsPatient(deps(), s.patient.user.id, id);
    const third = await createPatient(pool);
    const reuse = await requestUrgent(createPatientContext(s.doctor.doctorId, third.user.id), deps(), { patientId: third.patientId, category: "naranja", authorize: true });
    expect(reuse.kind === "scheduled" && reuse.startUtc.toISOString()).toBe(localAt(MX, "2026-06-15", "10:00").toISOString());
  });

  it("el tope de 10 cancelaciones por hora por cuenta sigue aplicando a las urgencias", async () => {
    const s = await scenario();
    const ids: number[] = [];
    for (let index = 0; index < 11; index += 1) {
      ids.push(await createAppointment(pool, { doctorId: s.doctor.doctorId, patientId: s.patient.patientId, startUtc: new Date(NOW.getTime() + (2 + index) * 3_600_000 * 24), kind: "urgent", createdByUserId: s.patient.user.id, createdByRole: "patient", createdAt: new Date(NOW.getTime() - 3 * 86_400_000) }));
    }
    for (const id of ids.slice(0, 10)) await cancelAsPatient(deps(), s.patient.user.id, id);
    await expect(cancelAsPatient(deps(), s.patient.user.id, ids[10] ?? 0)).rejects.toBeInstanceOf(TooManyAttemptsError);
  });

  it("tras cancelar, el paciente puede pedir otra urgencia (ya no está activa) pero la cancelada sigue contando en las 3 de 24 h", async () => {
    const s = await scenario();
    const first = await urgent(s);
    await cancelAsPatient(deps(), s.patient.user.id, first);
    const second = await urgent(s);
    expect(second).not.toBe(first);
    expect(await rows("SELECT id FROM calendar_action_log WHERE action = 'urgent_requested'")).toHaveLength(2);
  });

  it("no puede cancelar la urgencia de otra cuenta", async () => {
    const s = await scenario();
    const id = await urgent(s);
    const stranger = await createPatient(pool);
    await expect(cancelAsPatient(deps(), stranger.user.id, id)).rejects.toThrow();
    expect((await rows("SELECT status FROM appointment WHERE id = ?", [id]))[0]?.status).toBe("booked");
  });
});
