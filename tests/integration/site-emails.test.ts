import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPatientContext } from "../../src/lib/tenant.js";
import { reserveAsPatient } from "../../src/modules/site/booking-service.js";
import {
  clearTables,
  createDependent,
  createDoctor,
  createMembership,
  createPatient,
  createPublishedSite,
  createTestPool,
  createUser,
  ensurePrivacyDocument,
  resetDatabase,
  type CreatedDoctor,
  type CreatedPatient,
} from "./helpers/db.js";
import { createTestApp, type TestApp } from "./helpers/app.js";

const pool = createTestPool();
let t: TestApp;
const TUESDAY = "2026-06-16";

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  t.clock.set(new Date("2026-06-15T14:00:00.000Z"));
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

async function scenario(options: { timezone?: string } = {}): Promise<Scenario> {
  const doctor = await createDoctor(pool, { fullName: "Dra. Elena Ríos" });
  await createPublishedSite(pool, doctor, options.timezone ? { settings: { timezone: options.timezone } } : {});
  const patient = await createPatient(pool, { fullName: "Mario Quintana", email: "mario@example.com" });
  return { doctor, patient };
}

const reserve = (s: Scenario, patientId = s.patient.patientId, time = "10:00") =>
  reserveAsPatient(createPatientContext(s.doctor.doctorId, s.patient.user.id), { db: pool, clock: t.clock }, { startLocal: `${TUESDAY}T${time}`, patientId, authorize: true });

describe("reserva del paciente: correos", () => {
  it("la confirmación llega a la cuenta con fecha, hora local, dirección, teléfono, enlace y Reply-To del médico", async () => {
    const s = await scenario();
    await reserve(s);
    await t.runOutbox();
    const message = t.transport.sent.find((sent) => sent.to === "mario@example.com");
    expect(message).toBeDefined();
    expect(message?.subject).toBe("Tu cita dental fue agendada");
    expect(message?.subject).not.toContain("Mario");
    expect(message?.subject).not.toContain("Ríos");
    expect(message?.replyTo).toBe(s.doctor.user.email);
    expect(message?.text).toContain("Dra. Elena Ríos");
    expect(message?.text).toContain("Mario Quintana");
    expect(message?.text).toContain("10:00");
    expect(message?.text.toLowerCase()).toContain("martes");
    expect(message?.text).toContain("junio");
    expect(message?.text).toContain("Calle Falsa 123, Centro");
    expect(message?.text).toContain("5598765432");
    expect(message?.text).toMatch(/https?:\/\/\S+\/citas\/enlace\/\S+/);
  });

  it("muestra la hora en la zona del consultorio", async () => {
    const s = await scenario({ timezone: "America/Tijuana" });
    await reserve(s);
    await t.runOutbox();
    const message = t.transport.sent.find((sent) => sent.to === "mario@example.com");
    expect(message?.text).toContain("10:00");
    expect(message?.text).not.toContain("17:00");
  });

  it("crea un token por propósito y cita, de unos 400 días, y el outbox solo guarda el id de la cita", async () => {
    const s = await scenario();
    const appointment = await reserve(s);
    const outbox = await rows("SELECT template, payload_ref FROM email_outbox ORDER BY id");
    expect(outbox.map((row) => row.template).sort()).toEqual(["appointment_created", "doctor_appointment_booked"]);
    for (const row of outbox) expect(JSON.parse(String(row.payload_ref))).toEqual({ appointmentId: appointment.id });
    await t.runOutbox();
    const tokens = await rows("SELECT purpose, appointment_id, created_at, expires_at FROM one_time_token");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ purpose: "appointment_confirmation", appointment_id: appointment.id });
    const days = ((tokens[0]?.expires_at as Date).getTime() - (tokens[0]?.created_at as Date).getTime()) / 86_400_000;
    expect(days).toBeGreaterThanOrEqual(399);
    expect(days).toBeLessThanOrEqual(401);
  });

  it("el aviso al médico va al correo de su cuenta, solo con nombre, fecha, hora y «convencional»", async () => {
    const s = await scenario();
    await reserve(s);
    await t.runOutbox();
    const notice = t.transport.sent.find((sent) => sent.to === s.doctor.user.email);
    expect(notice).toBeDefined();
    expect(notice?.subject).toBe("Nueva cita agendada");
    expect(notice?.subject).not.toContain("Mario");
    expect(notice?.text).toContain("Mario Quintana");
    expect(notice?.text).toContain("10:00");
    expect(notice?.text.toLowerCase()).toContain("convencional");
    expect(notice?.text).toContain("/agenda/dia/2026-06-16");
    expect(notice?.text).not.toContain("5512345678"); // teléfono del paciente
    expect(notice?.text).not.toContain("mario@example.com");
  });

  it("recepción no recibe el aviso", async () => {
    const s = await scenario();
    const reception = await createUser(pool, { role: "reception", email: "recepcion@example.com" });
    await createMembership(pool, s.doctor.doctorId, reception.id);
    await reserve(s);
    await t.runOutbox();
    expect(t.transport.sent.map((sent) => sent.to).sort()).toEqual([s.doctor.user.email, "mario@example.com"].sort());
  });

  it("para un menor, los correos van a la cuenta del tutor y nombran al menor", async () => {
    const s = await scenario();
    const minorId = await createDependent(pool, s.patient.accountId, "Hijo de Mario");
    await reserve(s, minorId);
    await t.runOutbox();
    const message = t.transport.sent.find((sent) => sent.to === "mario@example.com");
    expect(message?.text).toContain("Hijo de Mario");
  });

  it("si la cita se cancela antes del envío, la confirmación no sale", async () => {
    const s = await scenario();
    const appointment = await reserve(s);
    await pool.execute("UPDATE appointment SET status = 'cancelled', cancelled_at = UTC_TIMESTAMP(3) WHERE id = ?", [appointment.id]);
    await t.runOutbox();
    expect(t.transport.sent.find((sent) => sent.to === "mario@example.com")).toBeUndefined();
    expect(await rows("SELECT status FROM email_outbox WHERE template = 'appointment_created'")).toEqual([{ status: "cancelled" }]);
  });

  it("un doble envío no encola correos nuevos", async () => {
    const s = await scenario();
    await reserve(s);
    await reserve(s);
    expect(await rows("SELECT id FROM email_outbox")).toHaveLength(2);
  });
});
