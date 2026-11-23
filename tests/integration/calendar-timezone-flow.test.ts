import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  clearTables,
  createCalendarHours,
  createCalendarSettings,
  createPatient,
  createTestPool,
  linkPatientToDoctor,
  resetDatabase,
} from "./helpers/db.js";
import { agendaClientFor, createTestApp, uniqueIp, type AgendaClient, type AuthedClient, type TestApp } from "./helpers/app.js";

// Flujo completo en America/Tijuana a través de los dos cambios de hora de 2026 (8 de marzo y 1 de noviembre).
const pool = createTestPool();
let t: TestApp;
const TJ = "America/Tijuana";
const SPRING = "2026-03-08"; // domingo: 02:00 → 03:00 (la hora 02:xx no existe)
const FALL = "2026-11-01"; // domingo: 02:00 → 01:00 (la hora 01:xx ocurre dos veces)

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

function get(client: AuthedClient, url: string, accept = "application/json") {
  return t.app.inject({ method: "GET", url, remoteAddress: uniqueIp(), headers: { cookie: client.cookie, accept } });
}

function post(client: AuthedClient, url: string, fields: Record<string, string>) {
  return t.app.inject({
    method: "POST",
    url,
    remoteAddress: uniqueIp(),
    headers: { cookie: client.cookie, accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ _csrf: client.csrf, ...fields }).toString(),
  });
}

async function setup(now: string, hours: { weekday: number; startMinute: number; endMinute: number }[], slot = 30): Promise<AgendaClient & { patientId: number }> {
  t.clock.set(new Date(now)); // antes de abrir la sesión: la sesión caduca por inactividad
  const agenda = await agendaClientFor(t, pool, "doctor");
  await createCalendarSettings(pool, agenda.doctor.doctorId, { timezone: TJ, slotMinutes: slot, gapMinutes: 0 });
  await createCalendarHours(pool, agenda.doctor.doctorId, hours);
  const patient = await createPatient(pool, { fullName: "Paciente de Frontera" });
  await linkPatientToDoctor(pool, agenda.doctor.doctorId, patient.patientId);
  return { ...agenda, patientId: patient.patientId };
}

async function rows(sql: string): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql);
  return result;
}

interface DayJson {
  slots: { start: string; end: string; state: string }[];
}

describe("salto de primavera (8 de marzo de 2026)", () => {
  const hours = [{ weekday: 7, startMinute: 60, endMinute: 5 * 60 }]; // domingo 01:00–05:00

  it("la agenda no ofrece la hora que no existe", async () => {
    const s = await setup("2026-03-01T18:00:00.000Z", hours);
    const day = (await get(s.client, `/agenda/dia/${SPRING}`)).json() as DayJson;
    expect(day.slots.map((slot) => slot.start.slice(11))).toEqual(["01:00", "01:30", "03:00", "03:30", "04:00", "04:30"]);
  });

  it("se puede agendar después del salto y se guarda en UTC con el desfase correcto", async () => {
    const s = await setup("2026-03-01T18:00:00.000Z", hours);
    expect((await post(s.client, "/agenda/citas", { inicio: `${SPRING}T03:00`, patientId: String(s.patientId) })).statusCode).toBe(303);
    // 03:00 PDT (UTC−7) = 10:00Z; 01:30 PST (UTC−8) = 09:30Z.
    expect((await post(s.client, "/agenda/citas", { inicio: `${SPRING}T01:30`, patientId: String(s.patientId) })).statusCode).toBe(303);
    const stored = await rows("SELECT start_utc FROM appointment ORDER BY start_utc");
    expect(stored.map((row) => (row.start_utc as Date).toISOString())).toEqual(["2026-03-08T09:30:00.000Z", "2026-03-08T10:00:00.000Z"]);
    const day = (await get(s.client, `/agenda/dia/${SPRING}`)).json() as DayJson;
    expect(day.slots.filter((slot) => slot.state === "booked").map((slot) => slot.start.slice(11))).toEqual(["01:30", "03:00"]);
  });

  it("agendar o bloquear en la hora inexistente se rechaza (400)", async () => {
    const s = await setup("2026-03-01T18:00:00.000Z", hours);
    expect((await post(s.client, "/agenda/citas", { inicio: `${SPRING}T02:30`, patientId: String(s.patientId) })).statusCode).toBe(400);
    expect((await post(s.client, "/agenda/bloqueos/espacio", { inicio: `${SPRING}T02:00` })).statusCode).toBe(400);
    expect(await rows("SELECT id FROM appointment")).toEqual([]);
  });

  it("un bloqueo que abarca el salto cubre los espacios de los dos lados", async () => {
    const s = await setup("2026-03-01T18:00:00.000Z", hours);
    const response = await post(s.client, "/agenda/bloqueos", { desdeFecha: SPRING, desdeHora: "01:00", hastaFecha: SPRING, hastaHora: "04:00" });
    expect(response.statusCode).toBe(303);
    const day = (await get(s.client, `/agenda/dia/${SPRING}`)).json() as DayJson;
    expect(day.slots.map((slot) => `${slot.start.slice(11)} ${slot.state}`)).toEqual([
      "01:00 blocked",
      "01:30 blocked",
      "03:00 blocked",
      "03:30 blocked",
      "04:00 free",
      "04:30 free",
    ]);
  });

  it("la vista de la semana del cambio muestra siete días y la hora local en HTML", async () => {
    const s = await setup("2026-03-01T18:00:00.000Z", hours);
    await post(s.client, "/agenda/citas", { inicio: `${SPRING}T03:00`, patientId: String(s.patientId) });
    const week = await get(s.client, "/agenda/semana/2026-03-04", "text/html");
    expect(week.statusCode).toBe(200);
    expect(week.body).toContain("03:00");
    expect(week.body).not.toContain("10:00"); // la hora UTC de esa cita no debe aparecer
    const json = (await get(s.client, "/agenda/semana/2026-03-04")).json() as { days: unknown[] };
    expect(json.days).toHaveLength(7);
  });
});

describe("retroceso de otoño (1 de noviembre de 2026)", () => {
  const hours = [{ weekday: 7, startMinute: 0, endMinute: 4 * 60 }]; // domingo 00:00–04:00

  it("la hora repetida no duplica espacios y se toma su primera ocurrencia", async () => {
    const s = await setup("2026-10-25T18:00:00.000Z", hours, 60);
    const day = (await get(s.client, `/agenda/dia/${FALL}`)).json() as DayJson;
    expect(day.slots.map((slot) => slot.start.slice(11))).toEqual(["00:00", "01:00", "02:00", "03:00"]);
  });

  it("una cita en la hora repetida usa la primera ocurrencia (UTC−7) y las siguientes siguen en orden", async () => {
    const s = await setup("2026-10-25T18:00:00.000Z", hours, 60);
    await post(s.client, "/agenda/citas", { inicio: `${FALL}T01:00`, patientId: String(s.patientId) });
    await post(s.client, "/agenda/citas", { inicio: `${FALL}T02:00`, patientId: String(s.patientId) });
    const stored = await rows("SELECT start_utc FROM appointment ORDER BY start_utc");
    // 01:00 PDT = 08:00Z (primera ocurrencia); 02:00 PST = 10:00Z (la 01:xx se repitió en UTC−8, 09:00Z).
    expect(stored.map((row) => (row.start_utc as Date).toISOString())).toEqual(["2026-11-01T08:00:00.000Z", "2026-11-01T10:00:00.000Z"]);
  });

  it("el día del retroceso dura 25 horas y los días vecinos no se solapan con él", async () => {
    const s = await setup("2026-10-25T18:00:00.000Z", [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, startMinute: 22 * 60, endMinute: 24 * 60 })), 60);
    const saturday = (await get(s.client, "/agenda/dia/2026-10-31")).json() as DayJson;
    const sunday = (await get(s.client, `/agenda/dia/${FALL}`)).json() as DayJson;
    const monday = (await get(s.client, "/agenda/dia/2026-11-02")).json() as DayJson;
    const instants = [...saturday.slots, ...sunday.slots, ...monday.slots].map((slot) => slot.start);
    expect(new Set(instants).size).toBe(instants.length);
    expect(sunday.slots.map((slot) => slot.start.slice(11))).toEqual(["22:00", "23:00"]);
  });
});

describe("zonas sin cambio de hora", () => {
  it("Ciudad de México mantiene UTC−6 todo el año", async () => {
    t.clock.set(new Date("2026-03-01T18:00:00.000Z"));
    const agenda = await agendaClientFor(t, pool, "doctor");
    await createCalendarSettings(pool, agenda.doctor.doctorId, { timezone: "America/Mexico_City", slotMinutes: 60, gapMinutes: 0 });
    await createCalendarHours(pool, agenda.doctor.doctorId, [{ weekday: 7, startMinute: 10 * 60, endMinute: 11 * 60 }]);
    const patient = await createPatient(pool);
    await linkPatientToDoctor(pool, agenda.doctor.doctorId, patient.patientId);
    for (const date of [SPRING, FALL]) {
      t.clock.set(new Date("2026-03-01T18:00:00.000Z"));
      expect((await post(agenda.client, "/agenda/citas", { inicio: `${date}T10:00`, patientId: String(patient.patientId) })).statusCode).toBe(303);
    }
    const stored = await rows("SELECT start_utc FROM appointment ORDER BY start_utc");
    expect(stored.map((row) => (row.start_utc as Date).toISOString())).toEqual(["2026-03-08T16:00:00.000Z", "2026-11-01T16:00:00.000Z"]);
  });
});
