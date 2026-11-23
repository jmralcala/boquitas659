import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  clearTables,
  createAppointment,
  createBlock,
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
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

function get(client: AuthedClient, url: string, accept = "application/json") {
  return t.app.inject({ method: "GET", url, remoteAddress: uniqueIp(), headers: { cookie: client.cookie, accept } });
}

function post(client: AuthedClient, url: string, fields: Record<string, string>, options: { csrf?: boolean; accept?: string } = {}) {
  return t.app.inject({
    method: "POST",
    url,
    remoteAddress: uniqueIp(),
    headers: { cookie: client.cookie, accept: options.accept ?? "application/json", "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ ...(options.csrf === false ? {} : { _csrf: client.csrf }), ...fields }).toString(),
  });
}

const RANGE = { desdeFecha: TUESDAY, desdeHora: "09:00", hastaFecha: TUESDAY, hastaHora: "12:00", motivo: "Congreso" };

async function setup(role: "doctor" | "reception" = "doctor"): Promise<AgendaClient & { patientId: number }> {
  const agenda = await agendaClientFor(t, pool, role);
  await createCalendarSettings(pool, agenda.doctor.doctorId);
  await createCalendarHours(pool, agenda.doctor.doctorId, WEEKDAY_HOURS);
  const patient = await createPatient(pool, { fullName: "Ana Pérez" });
  await linkPatientToDoctor(pool, agenda.doctor.doctorId, patient.patientId);
  return { ...agenda, patientId: patient.patientId };
}

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

describe.each(["doctor", "reception"] as const)("bloqueos (%s)", (role) => {
  it("GET /agenda/bloqueos lista los bloqueos vigentes o futuros en hora local", async () => {
    const s = await setup(role);
    await createBlock(pool, { doctorId: s.doctor.doctorId, startUtc: localAt(MX, TUESDAY, "09:00"), endUtc: localAt(MX, TUESDAY, "12:00"), reason: "Congreso" });
    await createBlock(pool, { doctorId: s.doctor.doctorId, startUtc: localAt(MX, "2026-06-10", "09:00"), endUtc: localAt(MX, "2026-06-10", "12:00") }); // ya pasó
    const response = await get(s.client, "/agenda/bloqueos");
    expect(response.statusCode).toBe(200);
    expect((response.json() as { blocks: unknown[] }).blocks).toMatchObject([
      { start: `${TUESDAY}T09:00`, end: `${TUESDAY}T12:00`, reason: "Congreso", createdByRole: "doctor" },
    ]);
  });

  it("POST /agenda/bloqueos sin citas: 303 y el bloqueo queda aplicado", async () => {
    const s = await setup(role);
    const response = await post(s.client, "/agenda/bloqueos", RANGE);
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/agenda/bloqueos");
    expect(await rows("SELECT reason, created_by_role FROM calendar_block")).toEqual([{ reason: "Congreso", created_by_role: role }]);
    const day = (await get(s.client, `/agenda/dia/${TUESDAY}`)).json() as { slots: { state: string }[] };
    expect(day.slots.slice(0, 5).map((slot) => slot.state)).toEqual(["blocked", "blocked", "blocked", "free", "free"]);
  });

  it("POST /agenda/bloqueos con citas: 409 con la lista (fecha, hora y nombre) y sin cambios", async () => {
    const s = await setup(role);
    const id = await createAppointment(pool, { doctorId: s.doctor.doctorId, patientId: s.patientId, startUtc: localAt(MX, TUESDAY, "10:00") });
    const response = await post(s.client, "/agenda/bloqueos", RANGE);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "appointments_in_range",
      message: "Ese horario incluye citas. Cancélalas primero y vuelve a intentar.",
      appointments: [{ id, startLocal: `${TUESDAY}T10:00`, patientName: "Ana Pérez" }],
      total: 1,
    });
    expect(await rows("SELECT id FROM calendar_block")).toEqual([]);
    expect(await rows("SELECT action, outcome FROM calendar_action_log")).toEqual([{ action: "block_rejected", outcome: "rejected" }]);
  });

  it("el 409 en HTML muestra cada cita, el nombre escapado y qué hacer", async () => {
    const s = await setup(role);
    const evil = await createPatient(pool, { fullName: "<b>Mala</b> Idea" });
    await linkPatientToDoctor(pool, s.doctor.doctorId, evil.patientId);
    const id = await createAppointment(pool, { doctorId: s.doctor.doctorId, patientId: evil.patientId, startUtc: localAt(MX, TUESDAY, "10:00") });
    const response = await post(s.client, "/agenda/bloqueos", RANGE, { accept: "text/html" });
    expect(response.statusCode).toBe(409);
    expect(response.body).toContain("Cancela estas citas y vuelve a intentar");
    expect(response.body).toContain("&lt;b&gt;Mala&lt;/b&gt; Idea");
    expect(response.body).not.toContain("<b>Mala</b>");
    expect(response.body).toContain("10:00");
    expect(response.body).toContain(`/agenda/citas/${id}`);
  });

  it("tras cancelar la cita en conflicto, el mismo bloqueo se aplica", async () => {
    const s = await setup(role);
    const id = await createAppointment(pool, { doctorId: s.doctor.doctorId, patientId: s.patientId, startUtc: localAt(MX, TUESDAY, "10:00") });
    expect((await post(s.client, "/agenda/bloqueos", RANGE)).statusCode).toBe(409);
    expect((await post(s.client, `/agenda/citas/${id}/cancelar`, {})).statusCode).toBe(303);
    expect((await post(s.client, "/agenda/bloqueos", RANGE)).statusCode).toBe(303);
  });

  it("POST /agenda/bloqueos/espacio bloquea un espacio libre y responde 303 al día", async () => {
    const s = await setup(role);
    const response = await post(s.client, "/agenda/bloqueos/espacio", { inicio: `${TUESDAY}T10:00` });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(`/agenda/dia/${TUESDAY}`);
    const day = (await get(s.client, `/agenda/dia/${TUESDAY}`)).json() as { slots: { start: string; state: string }[] };
    expect(day.slots.find((slot) => slot.start === `${TUESDAY}T10:00`)?.state).toBe("blocked");
  });

  it("POST /agenda/bloqueos/espacio con una cita: 409 con la lista", async () => {
    const s = await setup(role);
    await createAppointment(pool, { doctorId: s.doctor.doctorId, patientId: s.patientId, startUtc: localAt(MX, TUESDAY, "10:00") });
    const response = await post(s.client, "/agenda/bloqueos/espacio", { inicio: `${TUESDAY}T10:00` });
    expect(response.statusCode).toBe(409);
    expect((response.json() as { total: number }).total).toBe(1);
  });

  it("POST /agenda/bloqueos/:id/eliminar borra el bloqueo y responde 303", async () => {
    const s = await setup(role);
    const id = await createBlock(pool, { doctorId: s.doctor.doctorId, startUtc: localAt(MX, TUESDAY, "09:00"), endUtc: localAt(MX, TUESDAY, "12:00") });
    const response = await post(s.client, `/agenda/bloqueos/${id}/eliminar`, {});
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/agenda/bloqueos");
    expect(await rows("SELECT id FROM calendar_block")).toEqual([]);
    expect(await rows("SELECT actor_role, action FROM calendar_action_log")).toEqual([{ actor_role: role, action: "block_removed" }]);
  });
});

describe("POST /agenda/bloqueos: validación", () => {
  it.each([
    ["fin antes del inicio", { hastaHora: "08:00" }],
    ["fin en el pasado", { desdeFecha: "2026-06-10", hastaFecha: "2026-06-12" }],
    ["fecha inexistente", { desdeFecha: "2026-02-30" }],
    ["hora mal formada", { desdeHora: "9am" }],
    ["campo vacío", { hastaFecha: "" }],
    ["motivo demasiado largo", { motivo: "x".repeat(201) }],
    ["más de 366 días", { hastaFecha: "2027-06-18" }],
  ])("rechaza %s con 400 y no inserta nada", async (_name, override) => {
    const s = await setup();
    const response = await post(s.client, "/agenda/bloqueos", { ...RANGE, ...override });
    expect(response.statusCode).toBe(400);
    expect(await rows("SELECT id FROM calendar_block")).toEqual([]);
  });

  it("en HTML, un error de validación vuelve a pintar el formulario con lo escrito y los errores", async () => {
    const s = await setup();
    const response = await post(s.client, "/agenda/bloqueos", { ...RANGE, hastaHora: "08:00", motivo: "Mi motivo" }, { accept: "text/html" });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('value="Mi motivo"');
    expect(response.body).toContain('class="errors"');
  });

  it("POST /agenda/bloqueos/espacio con un inicio que no es un espacio: 400", async () => {
    const s = await setup();
    expect((await post(s.client, "/agenda/bloqueos/espacio", { inicio: `${TUESDAY}T10:20` })).statusCode).toBe(400);
    expect((await post(s.client, "/agenda/bloqueos/espacio", { inicio: "hoy" })).statusCode).toBe(400);
  });

  it("POST /agenda/bloqueos/:id/eliminar con un id mal formado: 400", async () => {
    const s = await setup();
    expect((await post(s.client, "/agenda/bloqueos/abc/eliminar", {})).statusCode).toBe(400);
  });
});

describe("acceso y aislamiento de bloqueos", () => {
  it("un bloqueo de otro médico responde 404 al eliminarlo y no cambia", async () => {
    const a = await setup();
    const b = await setup();
    const id = await createBlock(pool, { doctorId: a.doctor.doctorId, startUtc: localAt(MX, TUESDAY, "09:00"), endUtc: localAt(MX, TUESDAY, "12:00") });
    expect((await post(b.client, `/agenda/bloqueos/${id}/eliminar`, {})).statusCode).toBe(404);
    expect((await post(b.client, "/agenda/bloqueos/9999999/eliminar", {})).statusCode).toBe(404);
    expect(await rows("SELECT id FROM calendar_block")).toHaveLength(1);
  });

  it("GET /agenda/bloqueos no muestra los bloqueos de otro médico", async () => {
    const a = await setup();
    const b = await setup();
    await createBlock(pool, { doctorId: a.doctor.doctorId, startUtc: localAt(MX, TUESDAY, "09:00"), endUtc: localAt(MX, TUESDAY, "12:00"), reason: "Solo de A" });
    expect(((await get(b.client, "/agenda/bloqueos")).json() as { blocks: unknown[] }).blocks).toEqual([]);
  });

  it("el médico sale de la sesión: un doctorId en el cuerpo no cambia a quién se bloquea", async () => {
    const a = await setup();
    const b = await setup();
    const response = await post(a.client, "/agenda/bloqueos", { ...RANGE, doctorId: String(b.doctor.doctorId) });
    expect(response.statusCode).toBe(303);
    expect(await rows("SELECT doctor_id FROM calendar_block")).toEqual([{ doctor_id: a.doctor.doctorId }]);
  });

  it("sin el token CSRF: 403 y no cambia nada", async () => {
    const s = await setup();
    const id = await createBlock(pool, { doctorId: s.doctor.doctorId, startUtc: localAt(MX, TUESDAY, "09:00"), endUtc: localAt(MX, TUESDAY, "12:00") });
    expect((await post(s.client, "/agenda/bloqueos", RANGE, { csrf: false })).statusCode).toBe(403);
    expect((await post(s.client, "/agenda/bloqueos/espacio", { inicio: `${TUESDAY}T10:00` }, { csrf: false })).statusCode).toBe(403);
    expect((await post(s.client, `/agenda/bloqueos/${id}/eliminar`, {}, { csrf: false })).statusCode).toBe(403);
    expect(await rows("SELECT id FROM calendar_block")).toHaveLength(1);
  });

  it("sin sesión 401, paciente 403", async () => {
    const anonymous = await t.app.inject({ method: "GET", url: "/agenda/bloqueos", remoteAddress: uniqueIp(), headers: { accept: "application/json" } });
    expect(anonymous.statusCode).toBe(401);
    const patient = await createPatient(pool);
    const client = await sessionFor(t.services, patient.user);
    expect((await get(client, "/agenda/bloqueos")).statusCode).toBe(403);
    expect((await post(client, "/agenda/bloqueos", RANGE)).statusCode).toBe(403);
  });

  it("recepción con el vínculo retirado ya no puede bloquear ni desbloquear", async () => {
    const s = await setup("reception");
    const id = await createBlock(pool, { doctorId: s.doctor.doctorId, startUtc: localAt(MX, TUESDAY, "09:00"), endUtc: localAt(MX, TUESDAY, "12:00") });
    const [membership] = await pool.query<RowDataPacket[]>("SELECT id FROM reception_membership WHERE reception_user_id = ?", [s.user.id]);
    await t.services.memberships.remove(s.doctor.doctorId, s.doctor.user.id, Number(membership[0]?.id));
    expect([401, 403]).toContain((await post(s.client, "/agenda/bloqueos", RANGE)).statusCode);
    expect([401, 403]).toContain((await post(s.client, `/agenda/bloqueos/${id}/eliminar`, {})).statusCode);
    expect(await rows("SELECT id FROM calendar_block")).toHaveLength(1);
  });
});

describe("la agenda ofrece las acciones sobre cada espacio", () => {
  it("en HTML, un espacio libre ofrece agendar y bloquear; uno ocupado no", async () => {
    const s = await setup();
    await createAppointment(pool, { doctorId: s.doctor.doctorId, patientId: s.patientId, startUtc: localAt(MX, TUESDAY, "10:00") });
    const response = await get(s.client, `/agenda/dia/${TUESDAY}`, "text/html");
    expect(response.body).toContain(`/agenda/citas/nueva?inicio=${encodeURIComponent(`${TUESDAY}T09:00`)}`);
    expect(response.body).toContain('action="/agenda/bloqueos/espacio"');
    expect(response.body).toContain(`value="${TUESDAY}T09:00"`);
    expect(response.body).not.toContain(`inicio=${encodeURIComponent(`${TUESDAY}T10:00`)}`);
    expect(response.body).not.toContain(`value="${TUESDAY}T10:00"`);
  });

  it("en HTML, un bloqueo del día ofrece quitarlo", async () => {
    const s = await setup();
    const id = await createBlock(pool, { doctorId: s.doctor.doctorId, startUtc: localAt(MX, TUESDAY, "09:00"), endUtc: localAt(MX, TUESDAY, "12:00") });
    const response = await get(s.client, `/agenda/dia/${TUESDAY}`, "text/html");
    expect(response.body).toContain(`/agenda/bloqueos/${id}/eliminar`);
  });
});
