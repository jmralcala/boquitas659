import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  clearTables,
  createAppointment,
  createBlock,
  createCalendarHours,
  createCalendarSettings,
  createDoctor,
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
const NOW = new Date("2026-06-15T14:00:00.000Z"); // lunes 8:00 local
const TUESDAY = "2026-06-16";
const SLOT = `${TUESDAY}T10:00`;

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

function get(client: AuthedClient, url: string) {
  return t.app.inject({ method: "GET", url, remoteAddress: uniqueIp(), headers: { cookie: client.cookie, accept: "application/json" } });
}

function post(client: AuthedClient, url: string, fields: Record<string, string>, options: { csrf?: boolean } = {}) {
  return t.app.inject({
    method: "POST",
    url,
    remoteAddress: uniqueIp(),
    headers: { cookie: client.cookie, accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ ...(options.csrf === false ? {} : { _csrf: client.csrf }), ...fields }).toString(),
  });
}

async function setup(role: "doctor" | "reception" = "doctor"): Promise<AgendaClient & { patientId: number; accountEmail: string }> {
  const agenda = await agendaClientFor(t, pool, role);
  await createCalendarSettings(pool, agenda.doctor.doctorId);
  await createCalendarHours(pool, agenda.doctor.doctorId, WEEKDAY_HOURS);
  const patient = await createPatient(pool, { fullName: "Mario Quintana" });
  await linkPatientToDoctor(pool, agenda.doctor.doctorId, patient.patientId);
  return { ...agenda, patientId: patient.patientId, accountEmail: patient.user.email };
}

async function rows(sql: string): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql);
  return result;
}

describe.each(["doctor", "reception"] as const)("flujo de nueva cita (%s)", (role) => {
  it("pantalla de nueva cita → búsqueda por correo → crear cita", async () => {
    const s = await setup(role);
    const other = await createPatient(pool, { fullName: "Nueva Paciente", email: "nueva@example.com" });

    // 1. Pantalla: pacientes vinculados.
    const screen = await get(s.client, `/agenda/citas/nueva?inicio=${encodeURIComponent(SLOT)}`);
    expect(screen.statusCode).toBe(200);
    expect(screen.json()).toMatchObject({ inicio: SLOT, patients: [{ patientId: s.patientId, fullName: "Mario Quintana" }] });

    // 2. Búsqueda por correo exacto: nombres y boleto.
    const found = await post(s.client, "/agenda/citas/buscar", { inicio: SLOT, email: "nueva@example.com" });
    expect(found.statusCode).toBe(200);
    const result = found.json() as { patients: { patientId: number; fullName: string; ticket: string }[] };
    expect(result.patients).toMatchObject([{ patientId: other.patientId, fullName: "Nueva Paciente" }]);
    const ticket = result.patients[0]?.ticket ?? "";

    // 3. Crear la cita con boleto: vínculo, cita y correo.
    const created = await post(s.client, "/agenda/citas", { inicio: SLOT, patientId: String(other.patientId), ticket });
    expect(created.statusCode).toBe(303);
    expect(created.headers.location).toBe(`/agenda/dia/${TUESDAY}`);
    expect(await rows("SELECT patient_id, status FROM appointment")).toEqual([{ patient_id: other.patientId, status: "booked" }]);
    expect(await rows("SELECT patient_id FROM doctor_patient WHERE patient_id = " + other.patientId)).toHaveLength(1);
    // Feature 3: como el vínculo es nuevo, la cuenta también recibe el aviso de que el consultorio ya ve sus datos.
    expect((await rows("SELECT template FROM email_outbox ORDER BY id")).map((row) => row.template)).toEqual(["appointment_created", "patient_linked_by_office"]);
  });

  it("agendar a un paciente ya vinculado no necesita boleto", async () => {
    const s = await setup(role);
    const created = await post(s.client, "/agenda/citas", { inicio: SLOT, patientId: String(s.patientId) });
    expect(created.statusCode).toBe(303);
    const day = (await get(s.client, `/agenda/dia/${TUESDAY}`)).json() as { slots: { start: string; state: string }[] };
    expect(day.slots.find((slot) => slot.start === SLOT)?.state).toBe("booked");
  });
});

describe("GET /agenda/citas/nueva", () => {
  it("404 si el espacio no está libre y futuro ahora mismo", async () => {
    const s = await setup();
    await createAppointment(pool, { doctorId: s.doctor.doctorId, patientId: s.patientId, startUtc: localAt(MX, TUESDAY, "10:00") });
    await createBlock(pool, { doctorId: s.doctor.doctorId, startUtc: localAt(MX, TUESDAY, "11:00"), endUtc: localAt(MX, TUESDAY, "12:00") });
    for (const inicio of [SLOT, `${TUESDAY}T11:00`, `${TUESDAY}T10:30`, `${TUESDAY}T20:00`, "2026-06-15T08:00"]) {
      expect((await get(s.client, `/agenda/citas/nueva?inicio=${encodeURIComponent(inicio)}`)).statusCode, inicio).toBe(404);
    }
  });

  it("400 si `inicio` no es una fecha y hora válida", async () => {
    const s = await setup();
    expect((await get(s.client, "/agenda/citas/nueva?inicio=hoy")).statusCode).toBe(400);
    expect((await get(s.client, "/agenda/citas/nueva")).statusCode).toBe(400);
  });

  it("en HTML ofrece el formulario con la búsqueda y la lista de pacientes", async () => {
    const s = await setup();
    const response = await t.app.inject({
      method: "GET",
      url: `/agenda/citas/nueva?inicio=${encodeURIComponent(SLOT)}`,
      remoteAddress: uniqueIp(),
      headers: { cookie: s.client.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Mario Quintana");
    expect(response.body).toContain('action="/agenda/citas/buscar"');
    expect(response.body).toContain('action="/agenda/citas"');
    expect(response.body).toContain('name="_csrf"');
  });
});

describe("POST /agenda/citas/buscar", () => {
  it("sin cuenta: respuesta uniforme con lista vacía", async () => {
    const s = await setup();
    const response = await post(s.client, "/agenda/citas/buscar", { inicio: SLOT, email: "nadie@example.com" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ patients: [] });
  });

  it("la búsqueda 31 en una hora devuelve 429 con Retry-After", async () => {
    const s = await setup();
    for (let index = 0; index < 30; index += 1) {
      expect((await post(s.client, "/agenda/citas/buscar", { inicio: SLOT, email: `nadie${index}@example.com` })).statusCode).toBe(200);
    }
    const limited = await post(s.client, "/agenda/citas/buscar", { inicio: SLOT, email: "otra@example.com" });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(await rows("SELECT id FROM calendar_action_log WHERE action = 'patient_lookup'")).toHaveLength(30);
  });

  it("correo mal formado o ausente: 400", async () => {
    const s = await setup();
    expect((await post(s.client, "/agenda/citas/buscar", { inicio: SLOT })).statusCode).toBe(400);
    expect((await post(s.client, "/agenda/citas/buscar", { inicio: SLOT, email: "x".repeat(300) })).statusCode).toBe(400);
  });
});

describe("POST /agenda/citas: rechazos", () => {
  it("409 si el espacio está ocupado y no cambia nada", async () => {
    const s = await setup();
    await createAppointment(pool, { doctorId: s.doctor.doctorId, patientId: s.patientId, startUtc: localAt(MX, TUESDAY, "10:00") });
    const response = await post(s.client, "/agenda/citas", { inicio: SLOT, patientId: String(s.patientId) });
    expect(response.statusCode).toBe(409);
    expect(await rows("SELECT id FROM appointment")).toHaveLength(1);
    expect(await rows("SELECT id FROM email_outbox")).toEqual([]);
  });

  it("409 si el espacio está bloqueado", async () => {
    const s = await setup();
    await createBlock(pool, { doctorId: s.doctor.doctorId, startUtc: localAt(MX, TUESDAY, "09:00"), endUtc: localAt(MX, TUESDAY, "12:00") });
    expect((await post(s.client, "/agenda/citas", { inicio: SLOT, patientId: String(s.patientId) })).statusCode).toBe(409);
  });

  it("409 si el espacio ya pasó", async () => {
    t.clock.set(new Date("2026-06-15T17:00:00.000Z")); // lunes 11:00 locales; se fija antes de abrir la sesión (caduca por inactividad)
    const s = await setup();
    expect((await post(s.client, "/agenda/citas", { inicio: "2026-06-15T09:00", patientId: String(s.patientId) })).statusCode).toBe(409);
  });

  it("400 si el espacio no existe en el horario (fuera de franja o desfasado)", async () => {
    const s = await setup();
    expect((await post(s.client, "/agenda/citas", { inicio: `${TUESDAY}T20:00`, patientId: String(s.patientId) })).statusCode).toBe(400);
    expect((await post(s.client, "/agenda/citas", { inicio: `${TUESDAY}T10:20`, patientId: String(s.patientId) })).statusCode).toBe(400);
  });

  it("400 si falta el paciente o no es un número", async () => {
    const s = await setup();
    expect((await post(s.client, "/agenda/citas", { inicio: SLOT })).statusCode).toBe(400);
    expect((await post(s.client, "/agenda/citas", { inicio: SLOT, patientId: "abc" })).statusCode).toBe(400);
    expect((await post(s.client, "/agenda/citas", { inicio: SLOT, patientId: "-3" })).statusCode).toBe(400);
  });

  it("404 si el paciente no es alcanzable (de otro médico, sin boleto o inexistente)", async () => {
    const s = await setup();
    const stranger = await createPatient(pool);
    expect((await post(s.client, "/agenda/citas", { inicio: SLOT, patientId: String(stranger.patientId) })).statusCode).toBe(404);
    expect((await post(s.client, "/agenda/citas", { inicio: SLOT, patientId: "9999999", ticket: "1.x" })).statusCode).toBe(404);
    expect(await rows("SELECT id FROM appointment")).toEqual([]);
    expect(await rows("SELECT id FROM doctor_patient WHERE patient_id = " + stranger.patientId)).toEqual([]);
  });

  it("el médico sale de la sesión: un campo doctorId en el cuerpo no cambia a quién se agenda", async () => {
    const s = await setup();
    const other = await createDoctor(pool);
    await createCalendarSettings(pool, other.doctorId);
    await createCalendarHours(pool, other.doctorId, WEEKDAY_HOURS);
    const response = await post(s.client, "/agenda/citas", { inicio: SLOT, patientId: String(s.patientId), doctorId: String(other.doctorId) });
    expect(response.statusCode).toBe(303);
    expect(await rows("SELECT doctor_id FROM appointment")).toEqual([{ doctor_id: s.doctor.doctorId }]);
  });
});

describe("acceso", () => {
  it("sin el token CSRF: 403 y no se crea nada", async () => {
    const s = await setup();
    expect((await post(s.client, "/agenda/citas", { inicio: SLOT, patientId: String(s.patientId) }, { csrf: false })).statusCode).toBe(403);
    expect((await post(s.client, "/agenda/citas/buscar", { inicio: SLOT, email: "a@example.com" }, { csrf: false })).statusCode).toBe(403);
    expect(await rows("SELECT id FROM appointment")).toEqual([]);
  });

  it("sin sesión 401 y paciente 403", async () => {
    const response = await t.app.inject({ method: "GET", url: "/agenda/citas/nueva?inicio=" + encodeURIComponent(SLOT), remoteAddress: uniqueIp(), headers: { accept: "application/json" } });
    expect(response.statusCode).toBe(401);
    const patient = await createPatient(pool);
    const client = await sessionFor(t.services, patient.user);
    expect((await get(client, `/agenda/citas/nueva?inicio=${encodeURIComponent(SLOT)}`)).statusCode).toBe(403);
  });

  it("recepción con el vínculo retirado ya no puede agendar", async () => {
    const s = await setup("reception");
    const [membership] = await pool.query<RowDataPacket[]>("SELECT id FROM reception_membership WHERE reception_user_id = ?", [s.user.id]);
    await t.services.memberships.remove(s.doctor.doctorId, s.doctor.user.id, Number(membership[0]?.id));
    const response = await post(s.client, "/agenda/citas", { inicio: SLOT, patientId: String(s.patientId) });
    expect([401, 403]).toContain(response.statusCode);
    expect(await rows("SELECT id FROM appointment")).toEqual([]);
  });
});

describe("GET /agenda/citas/:id", () => {
  it("muestra el resumen de la cita con el enlace al detalle auditado y sin más datos del paciente", async () => {
    const s = await setup();
    const id = await createAppointment(pool, { doctorId: s.doctor.doctorId, patientId: s.patientId, startUtc: localAt(MX, TUESDAY, "10:00") });
    const response = await get(s.client, `/agenda/citas/${id}`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id,
      patientName: "Mario Quintana",
      start: SLOT,
      status: "booked",
      cancelable: true,
      patientDetailPath: `/agenda/pacientes/${s.patientId}`,
    });
    expect(JSON.stringify(response.json())).not.toContain("5512345678");
    expect(JSON.stringify(response.json())).not.toContain("@");
  });

  it("en HTML escapa el nombre, enlaza al detalle y ofrece cancelar", async () => {
    const s = await setup();
    const evil = await createPatient(pool, { fullName: "<img src=x onerror=alert(1)>" });
    const id = await createAppointment(pool, { doctorId: s.doctor.doctorId, patientId: evil.patientId, startUtc: localAt(MX, TUESDAY, "10:00") });
    const response = await t.app.inject({ method: "GET", url: `/agenda/citas/${id}`, remoteAddress: uniqueIp(), headers: { cookie: s.client.cookie } });
    expect(response.body).not.toContain("<img src=x");
    expect(response.body).toContain("&lt;img");
    expect(response.body).toContain(`/agenda/pacientes/${evil.patientId}`);
    expect(response.body).toContain(`/agenda/citas/${id}/cancelar`);
  });

  it("404 si la cita es de otro médico o no existe (no se distingue)", async () => {
    const a = await setup();
    const b = await setup();
    const id = await createAppointment(pool, { doctorId: a.doctor.doctorId, patientId: a.patientId, startUtc: localAt(MX, TUESDAY, "10:00") });
    expect((await get(b.client, `/agenda/citas/${id}`)).statusCode).toBe(404);
    expect((await get(b.client, "/agenda/citas/9999999")).statusCode).toBe(404);
    expect((await get(b.client, "/agenda/citas/abc")).statusCode).toBe(400);
  });
});
