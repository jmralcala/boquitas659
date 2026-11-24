import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTables, createAppointment, createCalendarHours, createCalendarSettings, createPatient, createTestPool, resetDatabase } from "../integration/helpers/db.js";
import { agendaClientFor, createTestApp, uniqueIp, type AuthedClient, type TestApp } from "../integration/helpers/app.js";

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

function get(client: AuthedClient, accept = "application/json") {
  return t.app.inject({ method: "GET", url: "/agenda/configuracion", headers: { cookie: client.cookie, accept }, remoteAddress: uniqueIp() });
}

function post(client: AuthedClient, fields: Record<string, string>, options: { csrf?: boolean } = {}) {
  return t.app.inject({
    method: "POST",
    url: "/agenda/configuracion",
    remoteAddress: uniqueIp(),
    headers: { cookie: client.cookie, accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ ...(options.csrf === false ? {} : { _csrf: client.csrf }), ...fields }).toString(),
  });
}

const VALID = {
  slotMinutes: "30",
  gapMinutes: "10",
  timezone: "America/Tijuana",
  minNoticeHours: "3",
  maxAdvanceDays: "45",
  h1_0_start: "09:00",
  h1_0_end: "14:00",
  h1_1_start: "16:00",
  h1_1_end: "19:00",
  h5_0_start: "08:00",
  h5_0_end: "12:00",
};

async function rows(sql: string): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql);
  return result;
}

describe("GET /agenda/configuracion", () => {
  it("a un médico nuevo le muestra los valores por defecto y ninguna franja", async () => {
    const { client } = await agendaClientFor(t, pool, "doctor");
    const response = await get(client);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      isDefault: true,
      settings: { slotMinutes: 45, gapMinutes: 15, timezone: "America/Mexico_City", minNoticeHours: 2, maxAdvanceDays: 60, cancelNoticeHours: 24, urgentMinNoticeMinutes: 30 },
      hours: [],
    });
  });

  it("en HTML muestra el formulario con los límites, la zona y los siete días", async () => {
    const { client } = await agendaClientFor(t, pool, "doctor");
    const response = await get(client, "text/html");
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('name="slotMinutes"');
    expect(response.body).toContain('value="45"');
    expect(response.body).toContain('name="_csrf"');
    expect(response.body).toContain("America/Mexico_City");
    for (const weekday of [1, 2, 3, 4, 5, 6, 7]) expect(response.body).toContain(`name="h${weekday}_0_start"`);
    expect(response.body).toContain('name="h1_3_end"');
    expect(response.body).not.toContain('name="h1_4_start"');
  });

  it("recepción recibe 403", async () => {
    const { client } = await agendaClientFor(t, pool, "reception");
    expect((await get(client)).statusCode).toBe(403);
  });
});

describe("POST /agenda/configuracion", () => {
  it("con datos válidos guarda, responde 303 y la pantalla lo refleja", async () => {
    const { client, doctor } = await agendaClientFor(t, pool, "doctor");
    const response = await post(client, VALID);
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/agenda/configuracion?guardado=1");

    expect((await get(client)).json()).toEqual({
      isDefault: false,
      settings: { slotMinutes: 30, gapMinutes: 10, timezone: "America/Tijuana", minNoticeHours: 3, maxAdvanceDays: 45, cancelNoticeHours: 24, urgentMinNoticeMinutes: 30 },
      hours: [
        { weekday: 1, start: "09:00", end: "14:00", kind: "regular" },
        { weekday: 1, start: "16:00", end: "19:00", kind: "regular" },
        { weekday: 5, start: "08:00", end: "12:00", kind: "regular" },
      ],
    });
    expect(await rows("SELECT action, doctor_id FROM calendar_action_log")).toEqual([{ action: "settings_updated", doctor_id: doctor.doctorId }]);
  });

  it("con datos inválidos responde 400 con un mensaje por campo y no guarda nada", async () => {
    const { client } = await agendaClientFor(t, pool, "doctor");
    const response = await post(client, { ...VALID, slotMinutes: "17", timezone: "Europe/Madrid", h1_0_start: "15:00" });
    expect(response.statusCode).toBe(400);
    const fields = (response.json() as { fields: Record<string, string[]> }).fields;
    expect(Object.keys(fields).sort()).toEqual(["h1_0", "slotMinutes", "timezone"]);
    expect(await rows("SELECT * FROM calendar_settings")).toEqual([]);
    expect(await rows("SELECT * FROM calendar_hours")).toEqual([]);
    expect(await rows("SELECT * FROM calendar_action_log")).toEqual([]);
  });

  it("un error de validación en HTML vuelve a pintar el formulario con los valores escritos y los errores", async () => {
    const { client } = await agendaClientFor(t, pool, "doctor");
    const response = await t.app.inject({
      method: "POST",
      url: "/agenda/configuracion",
      remoteAddress: uniqueIp(),
      headers: { cookie: client.cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ _csrf: client.csrf, ...VALID, slotMinutes: "17" }).toString(),
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('value="17"');
    expect(response.body).toContain('class="errors"');
  });

  it("el límite de cancelación se guarda con cancelNoticeHours y se rechaza fuera de 0–168", async () => {
    const { client } = await agendaClientFor(t, pool, "doctor");
    expect((await post(client, { ...VALID, cancelNoticeHours: "48" })).statusCode).toBe(303);
    expect((await get(client)).json()).toMatchObject({ settings: { cancelNoticeHours: 48 } });
    const bad = await post(client, { ...VALID, cancelNoticeHours: "169" });
    expect(bad.statusCode).toBe(400);
    expect(Object.keys((bad.json() as { fields: Record<string, string[]> }).fields)).toEqual(["cancelNoticeHours"]);
    expect((await get(client)).json()).toMatchObject({ settings: { cancelNoticeHours: 48 } });
  });

  it("el formulario en HTML incluye el límite de cancelación", async () => {
    const { client } = await agendaClientFor(t, pool, "doctor");
    const response = await get(client, "text/html");
    expect(response.body).toContain('name="cancelNoticeHours"');
    expect(response.body).toContain('value="24"');
  });

  it("un guardado posterior reemplaza las franjas anteriores", async () => {
    const { client } = await agendaClientFor(t, pool, "doctor");
    await post(client, VALID);
    const next = { slotMinutes: "45", gapMinutes: "15", timezone: "America/Mexico_City", minNoticeHours: "2", maxAdvanceDays: "60", h2_0_start: "10:00", h2_0_end: "12:00" };
    expect((await post(client, next)).statusCode).toBe(303);
    expect((await get(client)).json()).toMatchObject({ hours: [{ weekday: 2, start: "10:00", end: "12:00" }] });
  });

  it("recepción recibe 403 y no cambia nada", async () => {
    const { client } = await agendaClientFor(t, pool, "reception");
    expect((await post(client, VALID)).statusCode).toBe(403);
    expect(await rows("SELECT * FROM calendar_settings")).toEqual([]);
  });

  it("sin el token CSRF recibe 403 y no guarda", async () => {
    const { client } = await agendaClientFor(t, pool, "doctor");
    expect((await post(client, VALID, { csrf: false })).statusCode).toBe(403);
    expect(await rows("SELECT * FROM calendar_settings")).toEqual([]);
  });

  it("sin sesión recibe 401", async () => {
    const response = await t.app.inject({
      method: "POST",
      url: "/agenda/configuracion",
      remoteAddress: uniqueIp(),
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams(VALID).toString(),
    });
    expect([401, 403]).toContain(response.statusCode);
  });

  it("el médico sale del contexto, no de la petición: un médico no puede cambiar la configuración de otro", async () => {
    const a = await agendaClientFor(t, pool, "doctor");
    const b = await agendaClientFor(t, pool, "doctor");
    await createCalendarSettings(pool, a.doctor.doctorId, { slotMinutes: 60 });
    await createCalendarHours(pool, a.doctor.doctorId, [{ weekday: 3, startMinute: 600, endMinute: 660 }]);

    // B intenta apuntar a A con campos extra: se ignoran.
    const response = await post(b.client, { ...VALID, doctorId: String(a.doctor.doctorId), doctor_id: String(a.doctor.doctorId) });
    expect(response.statusCode).toBe(303);

    expect((await get(a.client)).json()).toMatchObject({
      settings: { slotMinutes: 60 },
      hours: [{ weekday: 3, start: "10:00", end: "11:00", kind: "regular" }],
    });
    expect((await get(b.client)).json()).toMatchObject({ settings: { slotMinutes: 30 } });
  });
});

describe("horario de urgencias en la configuración (feature 4)", () => {
  const WITH_URGENT = { ...VALID, urgentMinNoticeMinutes: "45", u1_0_start: "08:00", u1_0_end: "09:00", u6_0_start: "10:00", u6_0_end: "12:00", u6_1_start: "15:00", u6_1_end: "16:00" };

  it("GET en HTML muestra el bloque de urgencias (2 franjas por día) y la anticipación de urgencias con su valor por defecto", async () => {
    const { client } = await agendaClientFor(t, pool, "doctor");
    const response = await get(client, "text/html");
    expect(response.body).toContain('name="urgentMinNoticeMinutes"');
    expect(response.body).toContain('value="30"');
    for (const weekday of [1, 2, 3, 4, 5, 6, 7]) {
      expect(response.body).toContain(`name="u${weekday}_0_start"`);
      expect(response.body).toContain(`name="u${weekday}_1_end"`);
    }
    expect(response.body).not.toContain('name="u1_2_start"');
  });

  it("POST guarda ambas listas y la anticipación en una transacción; GET las devuelve con su tipo", async () => {
    const { client, doctor } = await agendaClientFor(t, pool, "doctor");
    expect((await post(client, WITH_URGENT)).statusCode).toBe(303);
    const json = (await get(client)).json() as { settings: { urgentMinNoticeMinutes: number }; hours: { weekday: number; start: string; end: string; kind: string }[] };
    expect(json.settings.urgentMinNoticeMinutes).toBe(45);
    expect(json.hours.filter((range) => range.kind === "urgent")).toEqual([
      { weekday: 1, start: "08:00", end: "09:00", kind: "urgent" },
      { weekday: 6, start: "10:00", end: "12:00", kind: "urgent" },
      { weekday: 6, start: "15:00", end: "16:00", kind: "urgent" },
    ]);
    expect(json.hours.filter((range) => range.kind === "regular")).toHaveLength(3);
    expect(await rows("SELECT action, doctor_id FROM calendar_action_log")).toEqual([{ action: "settings_updated", doctor_id: doctor.doctorId }]);
  });

  it("un solape entre una franja de urgencia y una convencional da 400 por la clave u<día>_<franja> y no guarda nada", async () => {
    const { client } = await agendaClientFor(t, pool, "doctor");
    const response = await post(client, { ...VALID, u1_0_start: "13:00", u1_0_end: "15:00" }); // h1_0 es 09:00–14:00
    expect(response.statusCode).toBe(400);
    expect(Object.keys((response.json() as { fields: Record<string, string[]> }).fields)).toEqual(["u1_0"]);
    expect(await rows("SELECT * FROM calendar_settings")).toEqual([]);
    expect(await rows("SELECT * FROM calendar_hours")).toEqual([]);
  });

  it("una anticipación de urgencias fuera de 0–1440 da 400 por su campo", async () => {
    const { client } = await agendaClientFor(t, pool, "doctor");
    const response = await post(client, { ...VALID, urgentMinNoticeMinutes: "1441" });
    expect(response.statusCode).toBe(400);
    expect(Object.keys((response.json() as { fields: Record<string, string[]> }).fields)).toEqual(["urgentMinNoticeMinutes"]);
  });

  it("sin el campo de anticipación de urgencias se guarda el valor por defecto (30)", async () => {
    const { client } = await agendaClientFor(t, pool, "doctor");
    expect((await post(client, VALID)).statusCode).toBe(303);
    expect(((await get(client)).json() as { settings: { urgentMinNoticeMinutes: number } }).settings.urgentMinNoticeMinutes).toBe(30);
  });

  it("recepción recibe 403 al leer y al guardar las urgencias, sin cambiar nada; sin CSRF 403", async () => {
    const { client } = await agendaClientFor(t, pool, "reception");
    expect((await get(client)).statusCode).toBe(403);
    expect((await post(client, WITH_URGENT)).statusCode).toBe(403);
    const doctor = await agendaClientFor(t, pool, "doctor");
    expect((await post(doctor.client, WITH_URGENT, { csrf: false })).statusCode).toBe(403);
    expect(await rows("SELECT * FROM calendar_hours WHERE kind = 'urgent'")).toEqual([]);
  });

  it("guardar las franjas de urgencia no modifica las citas ya agendadas", async () => {
    const { client, doctor } = await agendaClientFor(t, pool, "doctor");
    const patient = await createPatient(pool);
    const id = await createAppointment(pool, { doctorId: doctor.doctorId, patientId: patient.patientId, startUtc: new Date("2026-07-06T15:00:00.000Z") });
    const before = await rows("SELECT id, status, start_utc, end_utc, kind FROM appointment");
    expect((await post(client, WITH_URGENT)).statusCode).toBe(303);
    expect(await rows("SELECT id, status, start_utc, end_utc, kind FROM appointment")).toEqual(before);
    expect(id).toBeGreaterThan(0);
  });
});
