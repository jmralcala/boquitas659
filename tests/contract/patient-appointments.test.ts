import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  clearTables,
  createAppointment,
  createDependent,
  createDoctor,
  createPatient,
  createPublishedSite,
  createTestPool,
  ensurePrivacyDocument,
  resetDatabase,
  type CreatedDoctor,
  type CreatedPatient,
} from "../integration/helpers/db.js";
import { agendaClientFor, createSupportWithMfa, createTestApp, linkTokenSentTo, localAt, postForm, sessionFor, uniqueIp, type AuthedClient, type TestApp } from "../integration/helpers/app.js";
import { createPatientContext } from "../../src/lib/tenant.js";
import { reserveAsPatient } from "../../src/modules/site/booking-service.js";

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
  (t.transport.sent as unknown[]).length = 0;
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
  return { doctor, patient, client: await sessionFor(t.services, patient.user) };
}

const appointment = (s: Setup, date: string, time: string, patientId = s.patient.patientId) =>
  createAppointment(pool, { doctorId: s.doctor.doctorId, patientId, startUtc: localAt(MX, date, time), createdByUserId: s.patient.user.id });

const get = (url: string, client?: AuthedClient) =>
  t.app.inject({ method: "GET", url, remoteAddress: uniqueIp(), headers: { accept: "text/html", ...(client ? { cookie: client.cookie } : {}) } });

const post = (url: string, client: AuthedClient, fields: Record<string, string> = {}, ip?: string) =>
  postForm(t.app, url, { _csrf: client.csrf, ...fields }, client.cookie, ip);

describe("GET /pacientes/citas", () => {
  it("lista las citas próximas y recientes de la cuenta, con el botón de cancelar si se puede", async () => {
    const s = await setup();
    await createDependent(pool, s.patient.accountId, "Hijo de Mario");
    const id = await appointment(s, "2026-06-18", "10:00");
    await appointment(s, "2026-06-10", "10:00");
    const response = await get("/pacientes/citas", s.client);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Dra. Elena Ríos");
    expect(response.body).toContain("Mario Quintana");
    expect(response.body).toContain(`href="/pacientes/citas/${id}"`);
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
  });

  it("no muestra citas de otras cuentas", async () => {
    const s = await setup();
    const stranger = await createPatient(pool, { fullName: "Persona Ajena" });
    await createAppointment(pool, { doctorId: s.doctor.doctorId, patientId: stranger.patientId, startUtc: localAt(MX, "2026-06-18", "10:00") });
    expect((await get("/pacientes/citas", s.client)).body).not.toContain("Persona Ajena");
  });

  it("sin sesión pide iniciar sesión; el médico, la recepción y soporte reciben 403", async () => {
    const s = await setup();
    expect([302, 303, 401]).toContain((await get("/pacientes/citas")).statusCode);
    expect((await get("/pacientes/citas", await sessionFor(t.services, s.doctor.user))).statusCode).toBe(403);
    expect((await get("/pacientes/citas", (await agendaClientFor(t, pool, "reception", { doctor: s.doctor })).client)).statusCode).toBe(403);
    expect((await get("/pacientes/citas", await sessionFor(t.services, await createSupportWithMfa(t, pool)))).statusCode).toBe(403);
  });
});

describe("GET /pacientes/citas/:id", () => {
  it("muestra el detalle de una cita de la cuenta y 404 si es de otra cuenta", async () => {
    const s = await setup();
    const id = await appointment(s, "2026-06-18", "10:00");
    const ok = await get(`/pacientes/citas/${id}`, s.client);
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain("Calle Falsa 123, Centro");
    expect(ok.body).toContain(`action="/pacientes/citas/${id}/cancelar"`);
    const stranger = await createPatient(pool);
    expect((await get(`/pacientes/citas/${id}`, await sessionFor(t.services, stranger.user))).statusCode).toBe(404);
    expect((await get("/pacientes/citas/abc", s.client)).statusCode).toBe(400);
  });
});

describe("POST /pacientes/citas/:id/cancelar", () => {
  it("cancela, libera el horario y redirige a Mis citas", async () => {
    const s = await setup();
    const id = await appointment(s, "2026-06-18", "10:00");
    const response = await post(`/pacientes/citas/${id}/cancelar`, s.client);
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/pacientes/citas");
    expect((await rows("SELECT status, cancelled_by_role FROM appointment WHERE id = ?", [id]))[0]).toMatchObject({ status: "cancelled", cancelled_by_role: "patient" });
  });

  it("dentro del límite responde 409 cancellation_window_closed con el teléfono del consultorio", async () => {
    const s = await setup();
    const id = await appointment(s, "2026-06-16", "10:00");
    t.clock.set(new Date("2026-06-15T16:01:00.000Z"));
    const fresh = await sessionFor(t.services, s.patient.user);
    const response = await post(`/pacientes/citas/${id}/cancelar`, fresh);
    expect(response.statusCode).toBe(409);
    expect(response.body).toContain("55 9876 5432");
    expect((await rows("SELECT status FROM appointment WHERE id = ?", [id]))[0]?.status).toBe("booked");
  });

  it("ya cancelada responde 409 y ajena responde 404", async () => {
    const s = await setup();
    const id = await appointment(s, "2026-06-18", "10:00");
    await post(`/pacientes/citas/${id}/cancelar`, s.client);
    expect((await post(`/pacientes/citas/${id}/cancelar`, s.client)).statusCode).toBe(409);
    const stranger = await createPatient(pool);
    const other = await appointment(s, "2026-06-19", "10:00");
    expect((await post(`/pacientes/citas/${other}/cancelar`, await sessionFor(t.services, stranger.user))).statusCode).toBe(404);
  });

  it("sin token CSRF responde 403 y no cancela", async () => {
    const s = await setup();
    const id = await appointment(s, "2026-06-18", "10:00");
    const response = await postForm(t.app, `/pacientes/citas/${id}/cancelar`, {}, s.client.cookie);
    expect(response.statusCode).toBe(403);
    expect((await rows("SELECT status FROM appointment WHERE id = ?", [id]))[0]?.status).toBe("booked");
  });

  it("la 11.ª cancelación de la hora responde 429 con Retry-After", async () => {
    const s = await setup();
    const ids: number[] = [];
    for (const date of ["2026-06-17", "2026-06-18", "2026-06-19", "2026-06-22", "2026-06-23", "2026-06-24", "2026-06-25", "2026-06-26", "2026-06-29", "2026-06-30", "2026-07-01"]) {
      ids.push(await appointment(s, date, "10:00"));
    }
    let last = await post(`/pacientes/citas/${ids[0]}/cancelar`, s.client);
    for (const id of ids.slice(1)) last = await post(`/pacientes/citas/${id}/cancelar`, s.client);
    expect(last.statusCode).toBe(429);
    expect(Number(last.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("limita a 30 cancelaciones por hora por IP", async () => {
    const s = await setup();
    const ip = uniqueIp();
    let last = 0;
    for (let index = 0; index < 32; index += 1) last = (await post("/pacientes/citas/999999/cancelar", s.client, {}, ip)).statusCode;
    expect(last).toBe(429);
  });
});

describe("POST /citas/enlace/:token/cancelar", () => {
  async function linked() {
    const s = await setup();
    const result = await reserveAsPatient(createPatientContext(s.doctor.doctorId, s.patient.user.id), { db: pool, clock: t.clock }, { startLocal: "2026-06-18T10:00", patientId: s.patient.patientId, authorize: true });
    const token = await linkTokenSentTo(t, "mario@example.com", "/citas/enlace");
    return { s, id: result.id, token };
  }

  it("con la sesión de la cuenta dueña cancela y consume el token: la segunda vez es 410", async () => {
    const { s, id, token } = await linked();
    const response = await post(`/citas/enlace/${token}/cancelar`, s.client);
    expect(response.statusCode).toBe(303);
    expect((await rows("SELECT status FROM appointment WHERE id = ?", [id]))[0]?.status).toBe("cancelled");
    expect((await rows("SELECT used_at FROM one_time_token"))[0]?.used_at).not.toBeNull();
    expect((await post(`/citas/enlace/${token}/cancelar`, s.client)).statusCode).toBe(410);
  });

  it("con la sesión de otra cuenta responde el 410 genérico y no cancela", async () => {
    const { id, token } = await linked();
    const stranger = await createPatient(pool);
    const response = await post(`/citas/enlace/${token}/cancelar`, await sessionFor(t.services, stranger.user));
    expect(response.statusCode).toBe(410);
    expect((await rows("SELECT status FROM appointment WHERE id = ?", [id]))[0]?.status).toBe("booked");
  });

  it("sin sesión no cancela: lleva al inicio de sesión del enlace", async () => {
    const { id, token } = await linked();
    const anonymous = await t.app.inject({ method: "GET", url: `/citas/enlace/${token}`, remoteAddress: uniqueIp() });
    const csrf = anonymous.cookies.find((cookie) => cookie.name === "__Host-csrf");
    const field = /name="_csrf" value="([^"]+)"/.exec(anonymous.body)?.[1] ?? "";
    const response = await postForm(t.app, `/citas/enlace/${token}/cancelar`, { _csrf: field }, `__Host-csrf=${csrf?.value}`);
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(`/citas/enlace/${token}`);
    expect((await rows("SELECT status FROM appointment WHERE id = ?", [id]))[0]?.status).toBe("booked");
  });

  it("dentro del límite responde 409 y no consume el token", async () => {
    const { s, token } = await linked();
    t.clock.set(new Date("2026-06-17T16:30:00.000Z")); // menos de 24 h antes de la cita del jueves 10:00
    const fresh = await sessionFor(t.services, s.patient.user);
    const response = await post(`/citas/enlace/${token}/cancelar`, fresh);
    expect(response.statusCode).toBe(409);
    expect((await rows("SELECT used_at FROM one_time_token"))[0]?.used_at).toBeNull();
  });

  it("sin token CSRF responde 403", async () => {
    const { s, token } = await linked();
    expect((await postForm(t.app, `/citas/enlace/${token}/cancelar`, {}, s.client.cookie)).statusCode).toBe(403);
  });
});
