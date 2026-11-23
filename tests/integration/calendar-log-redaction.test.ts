import { Writable } from "node:stream";
import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  clearTables,
  createAppointment,
  createCalendarHours,
  createCalendarSettings,
  createPatient,
  createTestPool,
  linkPatientToDoctor,
  resetDatabase,
  WEEKDAY_HOURS,
} from "./helpers/db.js";
import { agendaClientFor, createTestApp, localAt, uniqueIp, type AuthedClient, type TestApp } from "./helpers/app.js";

// FR-033: los registros técnicos y el registro de acciones no contienen nombres, correos ni teléfonos de pacientes.
const pool = createTestPool();
let t: TestApp;
let captured = "";
const MX = "America/Mexico_City";
const TUESDAY = "2026-06-16";

const SECRETS = {
  name: "Nombre Muy Reconocible Pacheco",
  email: "paciente.reconocible@example.com",
  lookupEmail: "buscado.reconocible@example.com",
  lookupName: "Nombre Buscado Reconocible",
  phone: "5598761234",
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
  t.clock.set(new Date("2026-06-15T14:00:00.000Z"));
  (t.transport.sent as unknown[]).length = 0;
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

function request(client: AuthedClient, method: "GET" | "POST", url: string, fields: Record<string, string> = {}) {
  return t.app.inject({
    method,
    url,
    remoteAddress: uniqueIp(),
    headers: { cookie: client.cookie, accept: "application/json", ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    ...(method === "POST" ? { payload: new URLSearchParams({ _csrf: client.csrf, ...fields }).toString() } : {}),
  });
}

describe("redacción de datos personales en la agenda", () => {
  it("recorrer todos los flujos no deja nombres, correos ni teléfonos en el registro técnico ni en el registro de acciones", async () => {
    const agenda = await agendaClientFor(t, pool, "reception");
    const { client, doctor } = agenda;
    await createCalendarSettings(pool, doctor.doctorId);
    await createCalendarHours(pool, doctor.doctorId, WEEKDAY_HOURS);
    const patient = await createPatient(pool, { fullName: SECRETS.name, email: SECRETS.email });
    await pool.execute("UPDATE patient SET phone = ? WHERE id = ?", [SECRETS.phone, patient.patientId]);
    await linkPatientToDoctor(pool, doctor.doctorId, patient.patientId);
    const target = await createPatient(pool, { fullName: SECRETS.lookupName, email: SECRETS.lookupEmail });

    // Ver la agenda, buscar a un paciente por correo, agendar, ver la cita, cancelar, bloquear con conflicto y sin él.
    await request(client, "GET", `/agenda/dia/${TUESDAY}`);
    await request(client, "GET", `/agenda/semana/${TUESDAY}`);
    const found = await request(client, "POST", "/agenda/citas/buscar", { inicio: `${TUESDAY}T10:00`, email: SECRETS.lookupEmail });
    const ticket = (found.json() as { patients: { ticket: string }[] }).patients[0]?.ticket ?? "";
    await request(client, "POST", "/agenda/citas", { inicio: `${TUESDAY}T10:00`, patientId: String(target.patientId), ticket });
    await request(client, "POST", "/agenda/citas", { inicio: `${TUESDAY}T11:00`, patientId: String(patient.patientId) });
    const existing = await createAppointment(pool, { doctorId: doctor.doctorId, patientId: patient.patientId, startUtc: localAt(MX, TUESDAY, "12:00") });
    await request(client, "GET", `/agenda/citas/${existing}`);
    await request(client, "POST", "/agenda/bloqueos", { desdeFecha: TUESDAY, desdeHora: "09:00", hastaFecha: TUESDAY, hastaHora: "13:00" }); // 409
    await request(client, "POST", `/agenda/citas/${existing}/cancelar`);
    await request(client, "POST", "/agenda/bloqueos", { desdeFecha: TUESDAY, desdeHora: "16:00", hastaFecha: TUESDAY, hastaHora: "17:00", motivo: "Reunión" });
    await t.runOutbox();

    // 1. Registro técnico del servidor.
    expect(captured.length).toBeGreaterThan(0);
    for (const value of Object.values(SECRETS)) expect(captured, `el registro técnico contiene "${value}"`).not.toContain(value);
    expect(captured).not.toMatch(/__Host-(sid|csrf|did)/);
    expect(captured).not.toMatch(/set-cookie/i);

    // 2. Registro de acciones: ninguna columna con datos personales y ningún valor reconocible.
    const log = await pool.query<RowDataPacket[]>("SELECT * FROM calendar_action_log ORDER BY id");
    const logRows = log[0];
    expect(logRows.length).toBeGreaterThanOrEqual(5);
    for (const value of Object.values(SECRETS)) expect(JSON.stringify(logRows)).not.toContain(value);
    expect(new Set(logRows.map((row) => String(row.action)))).toEqual(
      new Set(["patient_lookup", "appointment_created", "block_rejected", "appointment_cancelled", "block_created"]),
    );

    // 3. El outbox solo guarda el id de la cita; el correo del destinatario es la dirección de envío, no un registro.
    const outbox = await pool.query<RowDataPacket[]>("SELECT template, payload_ref FROM email_outbox");
    for (const row of outbox[0]) {
      expect(JSON.parse(String(row.payload_ref))).toEqual({ appointmentId: expect.any(Number) });
    }
  });

  it("la lista de conflicto se entrega a quien bloquea, pero no se escribe en el registro técnico", async () => {
    const agenda = await agendaClientFor(t, pool, "doctor");
    await createCalendarSettings(pool, agenda.doctor.doctorId);
    await createCalendarHours(pool, agenda.doctor.doctorId, WEEKDAY_HOURS);
    const patient = await createPatient(pool, { fullName: SECRETS.name });
    await linkPatientToDoctor(pool, agenda.doctor.doctorId, patient.patientId);
    await createAppointment(pool, { doctorId: agenda.doctor.doctorId, patientId: patient.patientId, startUtc: localAt(MX, TUESDAY, "10:00") });
    const response = await request(agenda.client, "POST", "/agenda/bloqueos", { desdeFecha: TUESDAY, desdeHora: "09:00", hastaFecha: TUESDAY, hastaHora: "12:00" });
    expect(response.statusCode).toBe(409);
    expect(response.body).toContain(SECRETS.name); // se le muestra a quien la necesita para cancelar
    expect(captured).not.toContain(SECRETS.name);
  });
});
