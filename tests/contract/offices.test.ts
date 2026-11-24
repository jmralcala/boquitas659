import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  clearTables,
  createAppointment,
  createDoctor,
  createPatient,
  createPublishedSite,
  createTestPool,
  ensurePrivacyDocument,
  resetDatabase,
  type CreatedDoctor,
  type CreatedPatient,
} from "../integration/helpers/db.js";
import { agendaClientFor, createSupportWithMfa, createTestApp, localAt, postForm, sessionFor, uniqueIp, type AuthedClient, type TestApp } from "../integration/helpers/app.js";

const pool = createTestPool();
let t: TestApp;
const MX = "America/Mexico_City";
const NOW = new Date("2026-06-15T14:00:00.000Z");

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  t.clock.set(NOW);
  await ensurePrivacyDocument(pool);
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

interface Setup {
  doctor: CreatedDoctor;
  patient: CreatedPatient;
  client: AuthedClient;
}

async function setup(): Promise<Setup> {
  const doctor = await createDoctor(pool, { fullName: "Dra. Elena Ríos" });
  await createPublishedSite(pool, doctor, { slug: "clinica-rios" });
  const patient = await createPatient(pool, { fullName: "Mario Quintana", email: "mario@example.com" });
  await createAppointment(pool, { doctorId: doctor.doctorId, patientId: patient.patientId, startUtc: localAt(MX, "2026-06-18", "10:00"), createdByUserId: patient.user.id });
  await createAppointment(pool, { doctorId: doctor.doctorId, patientId: patient.patientId, startUtc: localAt(MX, "2026-06-19", "10:00"), createdByUserId: patient.user.id });
  return { doctor, patient, client: await sessionFor(t.services, patient.user) };
}

const get = (url: string, client?: AuthedClient) =>
  t.app.inject({ method: "GET", url, remoteAddress: uniqueIp(), headers: { accept: "text/html", ...(client ? { cookie: client.cookie } : {}) } });

describe("GET /pacientes/consultorios", () => {
  it("lista los consultorios con vínculo activo y su origen, con noindex", async () => {
    const s = await setup();
    const response = await get("/pacientes/consultorios", s.client);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Dra. Elena Ríos");
    expect(response.body).toContain("Lo creó el consultorio");
    expect(response.body).toContain(`href="/pacientes/consultorios/${s.doctor.doctorId}/revocar"`);
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
  });

  it("solo para pacientes: el médico, la recepción y soporte reciben 403; sin sesión se pide iniciar sesión", async () => {
    const s = await setup();
    expect((await get("/pacientes/consultorios", await sessionFor(t.services, s.doctor.user))).statusCode).toBe(403);
    expect((await get("/pacientes/consultorios", (await agendaClientFor(t, pool, "reception", { doctor: s.doctor })).client)).statusCode).toBe(403);
    expect((await get("/pacientes/consultorios", await sessionFor(t.services, await createSupportWithMfa(t, pool)))).statusCode).toBe(403);
    expect([302, 303, 401]).toContain((await get("/pacientes/consultorios")).statusCode);
  });
});

describe("GET /pacientes/consultorios/:doctorId/revocar", () => {
  it("muestra la confirmación con el número de citas que se cancelarán y qué deja de ver el consultorio", async () => {
    const s = await setup();
    const response = await get(`/pacientes/consultorios/${s.doctor.doctorId}/revocar`, s.client);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("2 citas");
    expect(response.body).toContain(`action="/pacientes/consultorios/${s.doctor.doctorId}/revocar"`);
    expect(response.body).toContain('name="_csrf"');
  });

  it("responde 404 sin vínculo activo (consultorio ajeno, inexistente o ya revocado)", async () => {
    const s = await setup();
    const other = await createDoctor(pool);
    expect((await get(`/pacientes/consultorios/${other.doctorId}/revocar`, s.client)).statusCode).toBe(404);
    expect((await get("/pacientes/consultorios/987654/revocar", s.client)).statusCode).toBe(404);
    expect((await get("/pacientes/consultorios/abc/revocar", s.client)).statusCode).toBe(400);
  });
});

describe("POST /pacientes/consultorios/:doctorId/revocar", () => {
  it("revoca, cancela las citas futuras y redirige a Mis consultorios", async () => {
    const s = await setup();
    const response = await postForm(t.app, `/pacientes/consultorios/${s.doctor.doctorId}/revocar`, { _csrf: s.client.csrf }, s.client.cookie);
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/pacientes/consultorios");
    expect(await rows("SELECT id FROM appointment WHERE status = 'booked'")).toEqual([]);
    expect(await rows("SELECT id FROM doctor_patient WHERE revoked_at IS NULL")).toEqual([]);
    expect((await get("/pacientes/consultorios", s.client)).body).not.toContain("Dra. Elena Ríos");
  });

  it("el consultorio revocado responde 404 en el detalle del paciente de la agenda", async () => {
    const s = await setup();
    const doctor = await agendaClientFor(t, pool, "doctor", { doctor: s.doctor });
    expect((await get(`/agenda/pacientes/${s.patient.patientId}`, doctor.client)).statusCode).toBe(200);
    await postForm(t.app, `/pacientes/consultorios/${s.doctor.doctorId}/revocar`, { _csrf: s.client.csrf }, s.client.cookie);
    expect((await get(`/agenda/pacientes/${s.patient.patientId}`, doctor.client)).statusCode).toBe(404);
  });

  it("sin token CSRF responde 403 y no revoca; la segunda vez responde 404; otra cuenta 404", async () => {
    const s = await setup();
    expect((await postForm(t.app, `/pacientes/consultorios/${s.doctor.doctorId}/revocar`, {}, s.client.cookie)).statusCode).toBe(403);
    expect(await rows("SELECT id FROM doctor_patient WHERE revoked_at IS NOT NULL")).toEqual([]);
    const stranger = await createPatient(pool);
    const other = await sessionFor(t.services, stranger.user);
    expect((await postForm(t.app, `/pacientes/consultorios/${s.doctor.doctorId}/revocar`, { _csrf: other.csrf }, other.cookie)).statusCode).toBe(404);
    await postForm(t.app, `/pacientes/consultorios/${s.doctor.doctorId}/revocar`, { _csrf: s.client.csrf }, s.client.cookie);
    expect((await postForm(t.app, `/pacientes/consultorios/${s.doctor.doctorId}/revocar`, { _csrf: s.client.csrf }, s.client.cookie)).statusCode).toBe(404);
  });

  it("solo el rol paciente puede revocar", async () => {
    const s = await setup();
    const doctorClient = await sessionFor(t.services, s.doctor.user);
    expect((await postForm(t.app, `/pacientes/consultorios/${s.doctor.doctorId}/revocar`, { _csrf: doctorClient.csrf }, doctorClient.cookie)).statusCode).toBe(403);
  });
});
