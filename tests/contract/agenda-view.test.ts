import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  clearTables,
  createAppointment,
  createBlock,
  createCalendarHours,
  createCalendarSettings,
  createDoctor,
  createMembership,
  createPatient,
  createTestPool,
  createUser,
  resetDatabase,
} from "../integration/helpers/db.js";
import { agendaClientFor, createTestApp, localAt, sessionFor, uniqueIp, type AuthedClient, type TestApp } from "../integration/helpers/app.js";

const pool = createTestPool();
let t: TestApp;
const MX = "America/Mexico_City";
const TJ = "America/Tijuana";
// Lunes 15 de junio de 2026, 8:00 hora de Ciudad de México.
const NOW = new Date("2026-06-15T14:00:00.000Z");
const MONDAY = "2026-06-15";

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  t.clock.set(NOW);
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

function get(client: AuthedClient | undefined, url: string, accept = "application/json") {
  return t.app.inject({
    method: "GET",
    url,
    remoteAddress: uniqueIp(),
    headers: { ...(client ? { cookie: client.cookie } : {}), accept },
  });
}

async function seedMonday(doctorId: number, zone = MX): Promise<void> {
  await createCalendarSettings(pool, doctorId, { timezone: zone });
  await createCalendarHours(pool, doctorId, [{ weekday: 1, startMinute: 9 * 60, endMinute: 14 * 60 }]);
}

interface DayJson {
  date: string;
  timezone: string;
  previousDate: string;
  nextDate: string;
  slots: { start: string; end: string; state: string; appointmentId?: number }[];
  appointments: { id: number; patientName: string; start: string; end: string; outOfSchedule: boolean }[];
  blocks: { id: number; start: string; end: string }[];
}

describe.each(["doctor", "reception"] as const)("GET /agenda/dia/:fecha (%s)", (role) => {
  it("devuelve espacios con estado, citas con el nombre del paciente y bloqueos, en hora local", async () => {
    const agenda = await agendaClientFor(t, pool, role);
    await seedMonday(agenda.doctor.doctorId);
    const patient = await createPatient(pool, { fullName: "Ana Pérez" });
    await createAppointment(pool, { doctorId: agenda.doctor.doctorId, patientId: patient.patientId, startUtc: localAt(MX, MONDAY, "10:00") });
    await createBlock(pool, { doctorId: agenda.doctor.doctorId, startUtc: localAt(MX, MONDAY, "12:00"), endUtc: localAt(MX, MONDAY, "13:00") });

    const response = await get(agenda.client, `/agenda/dia/${MONDAY}`);
    expect(response.statusCode).toBe(200);
    const day = response.json() as DayJson;
    expect(day.date).toBe(MONDAY);
    expect(day.timezone).toBe(MX);
    expect(day.previousDate).toBe("2026-06-14");
    expect(day.nextDate).toBe("2026-06-16");
    expect(day.slots.map((s) => [s.start.slice(11), s.state])).toEqual([
      ["09:00", "free"],
      ["10:00", "booked"],
      ["11:00", "free"],
      ["12:00", "blocked"],
      ["13:00", "free"],
    ]);
    expect(day.appointments).toMatchObject([{ patientName: "Ana Pérez", start: `${MONDAY}T10:00`, outOfSchedule: false }]);
    expect(day.blocks).toMatchObject([{ start: `${MONDAY}T12:00`, end: `${MONDAY}T13:00` }]);
  });

  it("los espacios que ya empezaron salen como pasados", async () => {
    t.clock.set(new Date("2026-06-15T17:00:00.000Z")); // 11:00 locales (antes de abrir la sesión: la sesión caduca por inactividad)
    const agenda = await agendaClientFor(t, pool, role);
    await seedMonday(agenda.doctor.doctorId);
    const day = (await get(agenda.client, `/agenda/dia/${MONDAY}`)).json() as DayJson;
    expect(day.slots.map((s) => s.state)).toEqual(["past", "past", "past", "free", "free"]);
  });

  it("en HTML muestra la hora local del consultorio y no la de UTC", async () => {
    const agenda = await agendaClientFor(t, pool, role);
    await createCalendarSettings(pool, agenda.doctor.doctorId, { timezone: TJ });
    await createCalendarHours(pool, agenda.doctor.doctorId, [{ weekday: 1, startMinute: 10 * 60, endMinute: 11 * 60 }]);
    const response = await get(agenda.client, `/agenda/dia/${MONDAY}`, "text/html");
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("10:00");
    expect(response.body).not.toContain("17:00");
    expect(response.body).toContain("lunes");
  });

  it("en HTML escapa el nombre del paciente y enlaza a la cita", async () => {
    const agenda = await agendaClientFor(t, pool, role);
    await seedMonday(agenda.doctor.doctorId);
    const patient = await createPatient(pool, { fullName: "<script>alert(1)</script>" });
    const id = await createAppointment(pool, { doctorId: agenda.doctor.doctorId, patientId: patient.patientId, startUtc: localAt(MX, MONDAY, "10:00") });
    const response = await get(agenda.client, `/agenda/dia/${MONDAY}`, "text/html");
    expect(response.body).not.toContain("<script>alert(1)</script>");
    expect(response.body).toContain("&lt;script&gt;");
    expect(response.body).toContain(`/agenda/citas/${id}`);
  });

  it("marca en HTML las citas fuera del horario actual", async () => {
    const agenda = await agendaClientFor(t, pool, role);
    await seedMonday(agenda.doctor.doctorId);
    const patient = await createPatient(pool, { fullName: "Paciente Tardía" });
    await createAppointment(pool, { doctorId: agenda.doctor.doctorId, patientId: patient.patientId, startUtc: localAt(MX, MONDAY, "20:00") });
    const response = await get(agenda.client, `/agenda/dia/${MONDAY}`, "text/html");
    expect(response.body).toContain("fuera del horario actual");
    expect(response.body).toContain("Paciente Tardía");
  });

  it("fecha inexistente, mal formada o fuera de rango: 400", async () => {
    const agenda = await agendaClientFor(t, pool, role);
    for (const fecha of ["2026-02-30", "15-06-2026", "hoy", "2026-6-1", "2029-01-01", "2020-01-01"]) {
      expect((await get(agenda.client, `/agenda/dia/${fecha}`)).statusCode, fecha).toBe(400);
    }
  });
});

describe.each(["doctor", "reception"] as const)("GET /agenda/semana/:fecha (%s)", (role) => {
  it("devuelve siete días de lunes a domingo con sus espacios y navegación a semanas vecinas", async () => {
    const agenda = await agendaClientFor(t, pool, role);
    await seedMonday(agenda.doctor.doctorId);
    const patient = await createPatient(pool, { fullName: "Luis Gómez" });
    await createAppointment(pool, { doctorId: agenda.doctor.doctorId, patientId: patient.patientId, startUtc: localAt(MX, MONDAY, "11:00") });

    const response = await get(agenda.client, "/agenda/semana/2026-06-18");
    expect(response.statusCode).toBe(200);
    const week = response.json() as { startDate: string; previousDate: string; nextDate: string; days: DayJson[] };
    expect(week.startDate).toBe(MONDAY);
    expect(week.days.map((d) => d.date)).toEqual(["2026-06-15", "2026-06-16", "2026-06-17", "2026-06-18", "2026-06-19", "2026-06-20", "2026-06-21"]);
    expect(week.previousDate).toBe("2026-06-08");
    expect(week.nextDate).toBe("2026-06-22");
    expect(week.days[0]?.slots.map((s) => s.state)).toEqual(["free", "free", "booked", "free", "free"]);
    expect(week.days[1]?.slots).toEqual([]);
  });

  it("en HTML enlaza cada día de la semana a su vista y a las semanas vecinas", async () => {
    const agenda = await agendaClientFor(t, pool, role);
    await seedMonday(agenda.doctor.doctorId);
    const response = await get(agenda.client, `/agenda/semana/${MONDAY}`, "text/html");
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("/agenda/dia/2026-06-17");
    expect(response.body).toContain("/agenda/semana/2026-06-08");
    expect(response.body).toContain("/agenda/semana/2026-06-22");
  });

  it("una fecha inválida responde 400", async () => {
    const agenda = await agendaClientFor(t, pool, role);
    expect((await get(agenda.client, "/agenda/semana/2026-13-01")).statusCode).toBe(400);
  });
});

describe("acceso y aislamiento de la agenda", () => {
  it("recepción con dos médicos solo ve el activo y cambia al cambiar de médico activo", async () => {
    const a = await createDoctor(pool);
    const b = await createDoctor(pool);
    await seedMonday(a.doctorId);
    await seedMonday(b.doctorId);
    const patientA = await createPatient(pool, { fullName: "Paciente de A" });
    const patientB = await createPatient(pool, { fullName: "Paciente de B" });
    await createAppointment(pool, { doctorId: a.doctorId, patientId: patientA.patientId, startUtc: localAt(MX, MONDAY, "10:00") });
    await createAppointment(pool, { doctorId: b.doctorId, patientId: patientB.patientId, startUtc: localAt(MX, MONDAY, "11:00") });

    const person = await createUser(pool, { role: "reception" });
    await createMembership(pool, a.doctorId, person.id);
    await createMembership(pool, b.doctorId, person.id);
    const client = await sessionFor(t.services, person);
    const session = await t.services.sessions.validate(client.cookie.split("=")[1] ?? "");

    await t.services.sessions.setActiveDoctor(session?.sessionId ?? 0, a.doctorId);
    const forA = (await get(client, `/agenda/dia/${MONDAY}`)).json() as DayJson;
    expect(forA.appointments.map((x) => x.patientName)).toEqual(["Paciente de A"]);

    await t.services.sessions.setActiveDoctor(session?.sessionId ?? 0, b.doctorId);
    const forB = (await get(client, `/agenda/dia/${MONDAY}`)).json() as DayJson;
    expect(forB.appointments.map((x) => x.patientName)).toEqual(["Paciente de B"]);
  });

  it("un médico no ve la agenda de otro", async () => {
    const a = await agendaClientFor(t, pool, "doctor");
    const b = await agendaClientFor(t, pool, "doctor");
    await seedMonday(a.doctor.doctorId);
    await seedMonday(b.doctor.doctorId);
    const patient = await createPatient(pool, { fullName: "Solo de A" });
    await createAppointment(pool, { doctorId: a.doctor.doctorId, patientId: patient.patientId, startUtc: localAt(MX, MONDAY, "10:00") });
    const forB = (await get(b.client, `/agenda/dia/${MONDAY}`)).json() as DayJson;
    expect(forB.appointments).toEqual([]);
    expect(forB.slots.map((s) => s.state)).toEqual(["free", "free", "free", "free", "free"]);
  });

  it("recepción con el vínculo retirado ya no entra en la siguiente petición", async () => {
    const agenda = await agendaClientFor(t, pool, "reception");
    await seedMonday(agenda.doctor.doctorId);
    expect((await get(agenda.client, `/agenda/dia/${MONDAY}`)).statusCode).toBe(200);
    const [membership] = await pool.query<import("mysql2/promise").RowDataPacket[]>(
      "SELECT id FROM reception_membership WHERE reception_user_id = ?",
      [agenda.user.id],
    );
    await t.services.memberships.remove(agenda.doctor.doctorId, agenda.doctor.user.id, Number(membership[0]?.id));
    expect([401, 403]).toContain((await get(agenda.client, `/agenda/dia/${MONDAY}`)).statusCode);
  });

  it("sin sesión 401, paciente 403", async () => {
    expect((await get(undefined, `/agenda/dia/${MONDAY}`)).statusCode).toBe(401);
    expect((await get(undefined, `/agenda/semana/${MONDAY}`)).statusCode).toBe(401);
    const patient = await createPatient(pool);
    const client = await sessionFor(t.services, patient.user);
    expect((await get(client, `/agenda/dia/${MONDAY}`)).statusCode).toBe(403);
    expect((await get(client, `/agenda/semana/${MONDAY}`)).statusCode).toBe(403);
  });
});
