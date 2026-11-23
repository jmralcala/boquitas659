import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTables, createCalendarSettings, createDoctor, createMembership, createPatient, createTestPool, createUser, resetDatabase } from "../integration/helpers/db.js";
import { agendaClientFor, createSupportWithMfa, createTestApp, sessionFor, type AuthedClient, type TestApp } from "../integration/helpers/app.js";
import { utcToLocal } from "../../src/lib/zoned-time.js";

const pool = createTestPool();
let t: TestApp;

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

function getAgenda(client?: AuthedClient) {
  return t.app.inject({
    method: "GET",
    url: "/agenda",
    headers: { ...(client ? { cookie: client.cookie } : {}), accept: "application/json" },
  });
}

describe("acceso a la agenda", () => {
  it("sin sesión: 401", async () => {
    expect((await getAgenda()).statusCode).toBe(401);
  });

  it("un paciente: 403", async () => {
    const patient = await createPatient(pool);
    expect((await getAgenda(await sessionFor(t.services, patient.user))).statusCode).toBe(403);
  });

  it("soporte (con doble factor): 403", async () => {
    const support = await createSupportWithMfa(t, pool);
    expect((await getAgenda(await sessionFor(t.services, support))).statusCode).toBe(403);
  });

  it.each(["pending", "rejected"] as const)("un médico %s: 403", async (status) => {
    const doctor = await createDoctor(pool, { status });
    expect((await getAgenda(await sessionFor(t.services, doctor.user))).statusCode).toBe(403);
  });

  it("recepción sin médico activo: 403", async () => {
    const doctor = await createDoctor(pool);
    const person = await createUser(pool, { role: "reception" });
    await createMembership(pool, doctor.doctorId, person.id);
    expect((await getAgenda(await sessionFor(t.services, person))).statusCode).toBe(403);
  });

  it("recepción con el vínculo retirado: la siguiente petición ya no entra", async () => {
    const reception = await agendaClientFor(t, pool, "reception");
    expect((await getAgenda(reception.client)).statusCode).toBe(303);
    const [membership] = await pool.query<import("mysql2/promise").RowDataPacket[]>(
      "SELECT id FROM reception_membership WHERE reception_user_id = ?",
      [reception.user.id],
    );
    await t.services.memberships.remove(reception.doctor.doctorId, reception.doctor.user.id, Number(membership[0]?.id));
    expect([401, 403]).toContain((await getAgenda(reception.client)).statusCode);
  });

  it.each(["doctor", "reception"] as const)("%s con acceso: 303 a la vista del día de hoy en la zona del consultorio", async (role) => {
    const agenda = await agendaClientFor(t, pool, role);
    await createCalendarSettings(pool, agenda.doctor.doctorId, { timezone: "America/Tijuana" });
    const response = await getAgenda(agenda.client);
    expect(response.statusCode).toBe(303);
    const today = utcToLocal("America/Tijuana", t.clock.now()).date;
    expect(response.headers.location).toBe(`/agenda/dia/${today}`);
  });

  it("un médico sin configuración usa la zona por defecto (Ciudad de México)", async () => {
    const agenda = await agendaClientFor(t, pool, "doctor");
    const response = await getAgenda(agenda.client);
    expect(response.headers.location).toBe(`/agenda/dia/${utcToLocal("America/Mexico_City", t.clock.now()).date}`);
  });
});
