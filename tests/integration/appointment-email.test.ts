import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import { createTestApp, type TestApp } from "./helpers/app.js";

const pool = createTestPool();
let t: TestApp;
const SECRET = "s".repeat(40);
const TUESDAY = "2026-06-16";

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  t.clock.set(new Date("2026-06-15T14:00:00.000Z"));
  // El transporte en memoria es el mismo para todas las pruebas del archivo: se vacía y se quitan los fallos pendientes.
  (t.transport.sent as unknown[]).length = 0;
  t.transport.failNext(0);
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

async function scenario(options: { timezone?: string; officePhone?: string } = {}): Promise<{ ctx: StaffContext; patientId: number; accountEmail: string; doctorName: string }> {
  const doctor = await createDoctor(pool, { fullName: "Dra. Elena Ríos" });
  if (options.officePhone) await pool.execute("UPDATE doctor SET office_phone = ? WHERE id = ?", [options.officePhone, doctor.doctorId]);
  await createCalendarSettings(pool, doctor.doctorId, { timezone: options.timezone ?? "America/Mexico_City" });
  await createCalendarHours(pool, doctor.doctorId, WEEKDAY_HOURS);
  const patient = await createPatient(pool, { fullName: "Mario Quintana", email: "mario@example.com" });
  await linkPatientToDoctor(pool, doctor.doctorId, patient.patientId);
  return { ctx: createTenantContext(doctor.doctorId, { kind: "doctor", userId: doctor.user.id }), patientId: patient.patientId, accountEmail: patient.user.email, doctorName: "Dra. Elena Ríos" };
}

const book = (s: { ctx: StaffContext; patientId: number }, time = "10:00") =>
  createAppointment(s.ctx, { db: pool, clock: t.clock, ticketSecret: SECRET }, { startLocal: `${TUESDAY}T${time}`, patientId: s.patientId });

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

describe("appointment_created", () => {
  it("llega a la cuenta del paciente con asunto sin datos personales y el detalle de la cita en el cuerpo", async () => {
    const s = await scenario({ officePhone: "5598765432" });
    await book(s);
    await t.runOutbox();

    expect(t.transport.sent).toHaveLength(1);
    const message = t.transport.sent[0];
    expect(message?.to).toBe(s.accountEmail);
    expect(message?.subject).toBe("Tu cita dental fue agendada");
    expect(message?.subject).not.toContain("Mario");
    expect(message?.subject).not.toContain("Ríos");
    expect(message?.text).toContain("Dra. Elena Ríos");
    expect(message?.text).toContain("Mario Quintana");
    expect(message?.text).toContain("10:00");
    expect(message?.text.toLowerCase()).toContain("martes");
    expect(message?.text).toContain("junio");
    expect(message?.text).toContain("5598765432");
  });

  it("un teléfono del consultorio que no son 10 dígitos nunca llega al correo", async () => {
    const s = await scenario({ officePhone: "5598765432" });
    await pool.execute("UPDATE doctor SET office_phone = 'ABCDE12345' WHERE id = ?", [s.ctx.doctorId]);
    await book(s);
    await t.runOutbox();
    expect(t.transport.sent[0]?.text).not.toContain("ABCDE12345");
    expect(t.transport.sent[0]?.text).toContain("comunícate con el consultorio");
  });

  it("muestra la hora en la zona del consultorio, no en UTC", async () => {
    const s = await scenario({ timezone: "America/Tijuana" });
    await book(s); // 10:00 en Tijuana = 17:00Z
    await t.runOutbox();
    expect(t.transport.sent[0]?.text).toContain("10:00");
    expect(t.transport.sent[0]?.text).not.toContain("17:00");
  });

  it("lleva el enlace para ver o cancelar la cita, la dirección y el Reply-To del médico (feature 3), sin datos clínicos", async () => {
    const s = await scenario();
    await pool.execute("INSERT INTO doctor_site (doctor_id, slug, address, status, created_at, updated_at) VALUES (?, 'consultorio-prueba', 'Calle Falsa 123, Centro', 'draft', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))", [s.ctx.doctorId]);
    await book(s);
    await t.runOutbox();
    const message = t.transport.sent[0];
    expect(message?.text).toMatch(/https?:\/\/\S+\/citas\/enlace\/\S+/);
    expect(message?.text).toContain("Calle Falsa 123, Centro");
    const [doctor] = await rows("SELECT u.email FROM doctor d JOIN `user` u ON u.id = d.user_id WHERE d.id = ?", [s.ctx.doctorId]);
    expect(message?.replyTo).toBe(String(doctor?.email));
  });

  it("el outbox solo guarda el id de la cita", async () => {
    const s = await scenario();
    const appointment = await book(s);
    const [row] = await rows("SELECT payload_ref FROM email_outbox");
    expect(JSON.parse(String(row?.payload_ref))).toEqual({ appointmentId: appointment.id });
    expect(String(row?.payload_ref)).not.toContain("Mario");
  });

  it("si la cita ya se canceló cuando toca enviarlo, el correo se cancela y no sale", async () => {
    const s = await scenario();
    const appointment = await book(s);
    await pool.execute("UPDATE appointment SET status = 'cancelled', cancelled_at = UTC_TIMESTAMP(3) WHERE id = ?", [appointment.id]);
    const result = await t.runOutbox();
    expect(result.cancelled).toBe(1);
    expect(t.transport.sent).toEqual([]);
    expect(await rows("SELECT status FROM email_outbox")).toEqual([{ status: "cancelled" }]);
  });

  it("si el correo no se puede entregar tras los reintentos, la cita se conserva", async () => {
    const s = await scenario();
    const appointment = await book(s);
    t.transport.failNext(10);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await t.runOutbox();
      t.clock.advance(2 * 3_600_000); // supera la espera creciente entre reintentos
    }
    expect(await rows("SELECT status, attempts FROM email_outbox")).toEqual([{ status: "failed", attempts: 3 }]);
    expect(await rows("SELECT status FROM appointment WHERE id = ?", [appointment.id])).toEqual([{ status: "booked" }]);
    expect(t.transport.sent).toEqual([]);
  });
});
