import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTables, createCalendarHours, createCalendarSettings, createTestPool, resetDatabase } from "../integration/helpers/db.js";
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
      settings: { slotMinutes: 45, gapMinutes: 15, timezone: "America/Mexico_City", minNoticeHours: 2, maxAdvanceDays: 60, cancelNoticeHours: 24 },
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
      settings: { slotMinutes: 30, gapMinutes: 10, timezone: "America/Tijuana", minNoticeHours: 3, maxAdvanceDays: 45, cancelNoticeHours: 24 },
      hours: [
        { weekday: 1, start: "09:00", end: "14:00" },
        { weekday: 1, start: "16:00", end: "19:00" },
        { weekday: 5, start: "08:00", end: "12:00" },
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
      hours: [{ weekday: 3, start: "10:00", end: "11:00" }],
    });
    expect((await get(b.client)).json()).toMatchObject({ settings: { slotMinutes: 30 } });
  });
});
