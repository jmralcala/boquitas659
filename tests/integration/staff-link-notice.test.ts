import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NotFoundError } from "../../src/http/errors.js";
import { createPatientContext, createTenantContext, type StaffContext } from "../../src/lib/tenant.js";
import { createAppointment } from "../../src/modules/calendar/appointment-service.js";
import { issueTicket } from "../../src/modules/calendar/patient-picker.js";
import { reserveAsPatient } from "../../src/modules/site/booking-service.js";
import { revoke } from "../../src/modules/site/offices-service.js";
import {
  clearTables,
  createDoctor,
  createPatient,
  createPublishedSite,
  createTestPool,
  ensurePrivacyDocument,
  linkPatientToDoctor,
  resetDatabase,
  type CreatedPatient,
} from "./helpers/db.js";
import { createTestApp, type TestApp } from "./helpers/app.js";

const pool = createTestPool();
let t: TestApp;
const SECRET = "s".repeat(40);
const NOW = new Date("2026-06-15T14:00:00.000Z");

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

const deps = () => ({ db: pool, clock: t.clock, ticketSecret: SECRET });

async function scenario(): Promise<{ ctx: StaffContext; doctorId: number; doctorUserId: number; patient: CreatedPatient }> {
  const doctor = await createDoctor(pool, { fullName: "Dra. Elena Ríos" });
  await createPublishedSite(pool, doctor, { slug: "clinica-rios" });
  const patient = await createPatient(pool, { fullName: "Mario Quintana", email: "mario@example.com" });
  return { ctx: createTenantContext(doctor.doctorId, { kind: "doctor", userId: doctor.user.id }), doctorId: doctor.doctorId, doctorUserId: doctor.user.id, patient };
}

describe("el personal vincula a un paciente (feature 2)", () => {
  it("el vínculo queda con origen office y quién lo creó, y la cuenta recibe patient_linked_by_office", async () => {
    const s = await scenario();
    const ticket = issueTicket(SECRET, s.ctx, s.patient.patientId, t.clock.now());
    const result = await createAppointment(s.ctx, deps(), { startLocal: "2026-06-17T10:00", patientId: s.patient.patientId, ticket });
    expect(await rows("SELECT origin, created_by_user_id, revoked_at FROM doctor_patient")).toEqual([{ origin: "office", created_by_user_id: s.doctorUserId, revoked_at: null }]);
    const outbox = await rows("SELECT template, to_email, payload_ref FROM email_outbox ORDER BY id");
    const notice = outbox.find((row) => row.template === "patient_linked_by_office");
    expect(notice?.to_email).toBe("mario@example.com");
    expect(JSON.parse(String(notice?.payload_ref))).toEqual({ appointmentId: result.id });

    await t.runOutbox();
    const message = t.transport.sent.find((sent) => sent.subject === "Un consultorio agendó una cita para ti");
    expect(message?.to).toBe("mario@example.com");
    expect(message?.text).toContain("Dra. Elena Ríos");
    expect(message?.text).toContain("2026");
    expect(message?.text).toContain("/pacientes/consultorios");
    expect(message?.text.toLowerCase()).toContain("revocar");
    expect(message?.text).not.toContain("5512345678");
  });

  it("si el paciente ya estaba vinculado no se vuelve a avisar", async () => {
    const s = await scenario();
    await linkPatientToDoctor(pool, s.doctorId, s.patient.patientId);
    await createAppointment(s.ctx, deps(), { startLocal: "2026-06-17T10:00", patientId: s.patient.patientId });
    expect(await rows("SELECT id FROM email_outbox WHERE template = 'patient_linked_by_office'")).toEqual([]);
  });

  it("un paciente que revocó ese consultorio no se puede agendar desde el personal (404, sin vínculo, cita ni correo)", async () => {
    const s = await scenario();
    const ctx = createPatientContext(s.doctorId, s.patient.user.id);
    await reserveAsPatient(ctx, { db: pool, clock: t.clock }, { startLocal: "2026-06-17T10:00", patientId: s.patient.patientId, authorize: true });
    await revoke({ db: pool, clock: t.clock }, s.patient.user.id, s.doctorId);
    const emails = (await rows("SELECT id FROM email_outbox")).length;
    const appointments = (await rows("SELECT id FROM appointment")).length;
    const ticket = issueTicket(SECRET, s.ctx, s.patient.patientId, t.clock.now());
    await expect(createAppointment(s.ctx, deps(), { startLocal: "2026-06-18T10:00", patientId: s.patient.patientId, ticket })).rejects.toBeInstanceOf(NotFoundError);
    await expect(createAppointment(s.ctx, deps(), { startLocal: "2026-06-18T10:00", patientId: s.patient.patientId })).rejects.toBeInstanceOf(NotFoundError);
    expect(await rows("SELECT id FROM appointment")).toHaveLength(appointments);
    expect(await rows("SELECT id FROM email_outbox")).toHaveLength(emails);
    expect(await rows("SELECT id FROM doctor_patient WHERE revoked_at IS NULL")).toEqual([]);
  });

  it("después de que el paciente vuelve a reservar él mismo, el personal sí puede agendarlo", async () => {
    const s = await scenario();
    const ctx = createPatientContext(s.doctorId, s.patient.user.id);
    await reserveAsPatient(ctx, { db: pool, clock: t.clock }, { startLocal: "2026-06-17T10:00", patientId: s.patient.patientId, authorize: true });
    await revoke({ db: pool, clock: t.clock }, s.patient.user.id, s.doctorId);
    t.clock.advance(60_000);
    await reserveAsPatient(ctx, { db: pool, clock: t.clock }, { startLocal: "2026-06-18T10:00", patientId: s.patient.patientId, authorize: true });
    const result = await createAppointment(s.ctx, deps(), { startLocal: "2026-06-19T10:00", patientId: s.patient.patientId });
    expect(result.id).toBeGreaterThan(0);
  });
});
