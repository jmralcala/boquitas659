import { Writable } from "node:stream";
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
  ensurePrivacyDocument,
  resetDatabase,
} from "./helpers/db.js";
import { anonymousForm, createTestApp, linkTokenSentTo, localAt, postForm, sessionFor, uniqueIp, type TestApp } from "./helpers/app.js";

// Los registros técnicos y el registro de acciones no contienen nombres, correos, teléfonos ni tokens de pacientes.
const pool = createTestPool();
let t: TestApp;
let captured = "";
const MX = "America/Mexico_City";
const NOW = new Date("2026-06-15T14:00:00.000Z");

const SECRETS = {
  newName: "Persona Nueva Reconocible Quiroz",
  newEmail: "nueva.reconocible@example.com",
  newPhone: "5598761111",
  oldName: "Paciente Existente Reconocible Zamora",
  oldEmail: "existente.reconocible@example.com",
  oldPhone: "5512345678",
};

beforeAll(async () => {
  await resetDatabase(pool);
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      captured += String(chunk);
      callback();
    },
  });
  t = await createTestApp(pool, {}, { logStream: stream });
});

beforeEach(async () => {
  await clearTables(pool);
  captured = "";
  t.clock.set(NOW);
  (t.transport.sent as unknown[]).length = 0;
  await ensurePrivacyDocument(pool);
  for (const type of ["doctor_privacy", "terms_doctor", "reception_privacy", "reception_confidentiality"] as const) {
    await t.services.legal.publish({ type, title: type, body: "texto", isProvisional: false });
  }
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

describe("redacción de datos personales en el micrositio y las citas del paciente", () => {
  it("recorrer entrar, registrar, reservar, cancelar, revocar, enlace y recordatorio no deja datos personales en los registros", async () => {
    const doctor = await createDoctor(pool, { fullName: "Dra. Elena Ríos" });
    await createPublishedSite(pool, doctor, { slug: "clinica-rios" });
    const existing = await createPatient(pool, { fullName: SECRETS.oldName, email: SECRETS.oldEmail });
    await pool.execute("UPDATE patient SET phone = ? WHERE id = ?", [SECRETS.oldPhone, existing.patientId]);

    // Entrada: primera cita (registro) e inicio de sesión de una cuenta existente.
    const form = await anonymousForm(t.app, "/c/clinica-rios/primera-cita");
    const registered = await postForm(
      t.app,
      "/c/clinica-rios/primera-cita",
      { _csrf: form.token, fullName: SECRETS.newName, birthDate: "1990-05-17", email: SECRETS.newEmail, phone: SECRETS.newPhone, password: "una-contraseña-segura-2026", acceptPrivacy: "yes" },
      form.cookie,
    );
    expect(registered.statusCode).toBe(303);
    const entry = await anonymousForm(t.app, "/c/clinica-rios/entrar");
    await postForm(t.app, "/c/clinica-rios/entrar", { _csrf: entry.token, email: SECRETS.oldEmail, password: "incorrecta-123456" }, entry.cookie);

    // Reserva, enlace, recordatorio, cancelación y revocación con la cuenta existente.
    let client = await sessionFor(t.services, existing.user);
    const post = (url: string, fields: Record<string, string> = {}) => postForm(t.app, url, { _csrf: client.csrf, ...fields }, client.cookie);
    const first = await post("/c/clinica-rios/reservar", { inicio: "2026-06-18T10:00", patientId: String(existing.patientId), autorizo: "yes" });
    expect(first.statusCode).toBe(303);
    const second = await post("/c/clinica-rios/reservar", { inicio: "2026-06-19T10:00", patientId: String(existing.patientId), autorizo: "yes" });
    expect(second.statusCode).toBe(303);
    const token = await linkTokenSentTo(t, SECRETS.oldEmail, "/citas/enlace");
    await t.app.inject({ method: "GET", url: `/citas/enlace/${token}`, remoteAddress: uniqueIp(), headers: { cookie: client.cookie } });
    t.clock.set(new Date("2026-06-17T08:00:00.000Z"));
    client = await sessionFor(t.services, existing.user); // la sesión anterior ya venció con el salto del reloj
    await enqueueDueReminders(pool, t.clock);
    await t.runOutbox();
    const [appointment] = await rows("SELECT id FROM appointment ORDER BY id LIMIT 1");
    await post(`/pacientes/citas/${appointment?.id}/cancelar`);
    await post(`/pacientes/consultorios/${doctor.doctorId}/revocar`);
    await t.app.inject({ method: "GET", url: "/pacientes/citas", remoteAddress: uniqueIp(), headers: { cookie: client.cookie } });

    expect(captured.length).toBeGreaterThan(0);
    // Registros técnicos: sin nombres, correos, teléfonos ni el token del enlace.
    for (const secret of [...Object.values(SECRETS), token]) expect(captured, `el registro técnico contiene «${secret}»`).not.toContain(secret);

    // Registro de acciones: solo identificadores, acciones y fechas.
    const actions = JSON.stringify(await rows("SELECT * FROM calendar_action_log"));
    for (const secret of Object.values(SECRETS)) expect(actions).not.toContain(secret);
    expect(await rows("SELECT DISTINCT action FROM calendar_action_log ORDER BY action")).toEqual(
      expect.arrayContaining([{ action: "appointment_created" }, { action: "appointment_cancelled" }, { action: "data_authorized" }, { action: "link_revoked" }]),
    );

    // Outbox: el payload solo tiene identificadores (y el motivo de la cancelación por revocación).
    for (const row of await rows("SELECT payload_ref FROM email_outbox")) {
      const payload = JSON.parse(String(row.payload_ref)) as Record<string, unknown>;
      expect(Object.keys(payload).every((key) => key === "appointmentId" || key === "reason" || key === "userId" || key === "at")).toBe(true);
      for (const secret of Object.values(SECRETS)) expect(String(row.payload_ref)).not.toContain(secret);
    }
  });

  it("el aviso al médico no incluye el teléfono ni el correo del paciente", async () => {
    const doctor = await createDoctor(pool);
    await createPublishedSite(pool, doctor, { slug: "clinica-rios" });
    const patient = await createPatient(pool, { fullName: SECRETS.oldName, email: SECRETS.oldEmail });
    await pool.execute("UPDATE patient SET phone = ? WHERE id = ?", [SECRETS.oldPhone, patient.patientId]);
    await createAppointment(pool, { doctorId: doctor.doctorId, patientId: patient.patientId, startUtc: localAt(MX, "2026-06-18", "10:00"), createdByUserId: patient.user.id, createdByRole: "patient" });
    const client = await sessionFor(t.services, patient.user);
    await postForm(t.app, "/c/clinica-rios/reservar", { _csrf: client.csrf, inicio: "2026-06-18T11:00", patientId: String(patient.patientId), autorizo: "yes" }, client.cookie);
    await t.runOutbox();
    const notice = t.transport.sent.find((sent) => sent.to === doctor.user.email);
    expect(notice?.text).toContain(SECRETS.oldName);
    expect(notice?.text).not.toContain(SECRETS.oldPhone);
    expect(notice?.text).not.toContain(SECRETS.oldEmail);
  });
});
