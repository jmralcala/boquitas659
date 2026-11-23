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
} from "../integration/helpers/db.js";
import { agendaClientFor, createTestApp, localAt, sessionFor, uniqueIp, type AgendaClient, type AuthedClient, type TestApp } from "../integration/helpers/app.js";

const pool = createTestPool();
let t: TestApp;
const MX = "America/Mexico_City";
const NOW = new Date("2026-06-15T14:00:00.000Z"); // lunes 8:00 locales
const TUESDAY = "2026-06-16";

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

function cancel(client: AuthedClient, id: number | string, options: { csrf?: boolean } = {}) {
  return t.app.inject({
    method: "POST",
    url: `/agenda/citas/${id}/cancelar`,
    remoteAddress: uniqueIp(),
    headers: { cookie: client.cookie, accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(options.csrf === false ? {} : { _csrf: client.csrf }).toString(),
  });
}

async function setup(role: "doctor" | "reception" = "doctor"): Promise<AgendaClient & { patientId: number; appointmentId: number; patientEmail: string }> {
  const agenda = await agendaClientFor(t, pool, role);
  await createCalendarSettings(pool, agenda.doctor.doctorId);
  await createCalendarHours(pool, agenda.doctor.doctorId, WEEKDAY_HOURS);
  const patient = await createPatient(pool, { fullName: "Mario Quintana", email: `mario${agenda.doctor.doctorId}@example.com` });
  await linkPatientToDoctor(pool, agenda.doctor.doctorId, patient.patientId);
  const appointmentId = await createAppointment(pool, { doctorId: agenda.doctor.doctorId, patientId: patient.patientId, startUtc: localAt(MX, TUESDAY, "10:00") });
  return { ...agenda, patientId: patient.patientId, appointmentId, patientEmail: patient.user.email };
}

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

describe.each(["doctor", "reception"] as const)("POST /agenda/citas/:id/cancelar (%s)", (role) => {
  it("cancela, redirige a la agenda del día de la cita y deja libre el espacio", async () => {
    const s = await setup(role);
    const response = await cancel(s.client, s.appointmentId);
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(`/agenda/dia/${TUESDAY}`);
    expect(await rows("SELECT status, cancelled_by_role FROM appointment WHERE id = ?", [s.appointmentId])).toEqual([
      { status: "cancelled", cancelled_by_role: role },
    ]);
    const day = await t.app.inject({ method: "GET", url: `/agenda/dia/${TUESDAY}`, remoteAddress: uniqueIp(), headers: { cookie: s.client.cookie, accept: "application/json" } });
    const slots = (day.json() as { slots: { start: string; state: string }[] }).slots;
    expect(slots.find((slot) => slot.start === `${TUESDAY}T10:00`)?.state).toBe("free");
  });

  it("el paciente recibe «Tu cita dental fue cancelada» sin datos personales en el asunto", async () => {
    const s = await setup(role);
    await cancel(s.client, s.appointmentId);
    await t.runOutbox();
    expect(t.transport.sent).toHaveLength(1);
    const message = t.transport.sent[0];
    expect(message?.to).toBe(s.patientEmail);
    expect(message?.subject).toBe("Tu cita dental fue cancelada");
    expect(message?.subject).not.toContain("Mario");
    expect(message?.text).toContain("Mario Quintana");
    expect(message?.text).toContain("10:00");
    expect(message?.text).not.toMatch(/https?:\/\//);
  });

  it("cancelar otra vez responde 409 y no repite el aviso", async () => {
    const s = await setup(role);
    expect((await cancel(s.client, s.appointmentId)).statusCode).toBe(303);
    expect((await cancel(s.client, s.appointmentId)).statusCode).toBe(409);
    expect(await rows("SELECT id FROM email_outbox WHERE template = 'appointment_cancelled'")).toHaveLength(1);
  });
});

describe("POST /agenda/citas/:id/cancelar: rechazos", () => {
  it("una cita que ya terminó responde 409", async () => {
    t.clock.set(new Date("2026-06-16T17:00:00.000Z")); // martes 11:00 locales: la cita de las 10:00 terminó a las 10:45
    const s = await setup();
    expect((await cancel(s.client, s.appointmentId)).statusCode).toBe(409);
    expect(await rows("SELECT status FROM appointment WHERE id = ?", [s.appointmentId])).toEqual([{ status: "booked" }]);
  });

  it("una cita de otro médico o inexistente responde 404 y no cambia", async () => {
    const a = await setup();
    const b = await setup();
    expect((await cancel(b.client, a.appointmentId)).statusCode).toBe(404);
    expect((await cancel(b.client, 9_999_999)).statusCode).toBe(404);
    expect(await rows("SELECT status FROM appointment WHERE id = ?", [a.appointmentId])).toEqual([{ status: "booked" }]);
    expect(await rows("SELECT id FROM email_outbox")).toEqual([]);
  });

  it("un id mal formado responde 400", async () => {
    const s = await setup();
    expect((await cancel(s.client, "abc")).statusCode).toBe(400);
    expect((await cancel(s.client, "0")).statusCode).toBe(400);
  });

  it("sin el token CSRF responde 403 y no cancela", async () => {
    const s = await setup();
    expect((await cancel(s.client, s.appointmentId, { csrf: false })).statusCode).toBe(403);
    expect(await rows("SELECT status FROM appointment WHERE id = ?", [s.appointmentId])).toEqual([{ status: "booked" }]);
  });

  it("sin sesión 401 y paciente 403", async () => {
    const s = await setup();
    const anonymous = await t.app.inject({
      method: "POST",
      url: `/agenda/citas/${s.appointmentId}/cancelar`,
      remoteAddress: uniqueIp(),
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      payload: "",
    });
    expect([401, 403]).toContain(anonymous.statusCode);
    const patient = await createPatient(pool);
    const client = await sessionFor(t.services, patient.user);
    expect((await cancel(client, s.appointmentId)).statusCode).toBe(403);
    expect(await rows("SELECT status FROM appointment WHERE id = ?", [s.appointmentId])).toEqual([{ status: "booked" }]);
  });

  it("recepción con el vínculo retirado ya no puede cancelar", async () => {
    const s = await setup("reception");
    const [membership] = await pool.query<RowDataPacket[]>("SELECT id FROM reception_membership WHERE reception_user_id = ?", [s.user.id]);
    await t.services.memberships.remove(s.doctor.doctorId, s.doctor.user.id, Number(membership[0]?.id));
    expect([401, 403]).toContain((await cancel(s.client, s.appointmentId)).statusCode);
    expect(await rows("SELECT status FROM appointment WHERE id = ?", [s.appointmentId])).toEqual([{ status: "booked" }]);
  });

  it("una petición GET a la ruta de cancelar no cambia nada (abrir un enlace nunca cancela)", async () => {
    const s = await setup();
    const response = await t.app.inject({
      method: "GET",
      url: `/agenda/citas/${s.appointmentId}/cancelar`,
      remoteAddress: uniqueIp(),
      headers: { cookie: s.client.cookie, accept: "application/json" },
    });
    expect(response.statusCode).toBe(404);
    expect(await rows("SELECT status FROM appointment WHERE id = ?", [s.appointmentId])).toEqual([{ status: "booked" }]);
  });
});
