import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPatientContext } from "../../src/lib/tenant.js";
import { requestUrgent } from "../../src/modules/urgent/urgent-service.js";
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
import { anonymousForm, createTestApp, linkTokenSentTo, localAt, postForm, sessionFor, uniqueIp, type AuthedClient, type TestApp } from "../integration/helpers/app.js";

const pool = createTestPool();
let t: TestApp;
const MX = "America/Mexico_City";
const NOW = new Date("2026-06-15T14:00:00.000Z"); // lunes 8:00 en Ciudad de México
const URGENT = [{ weekday: 1, startMinute: 10 * 60, endMinute: 12 * 60, kind: "urgent" as const }];

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
  urgentId: number;
}

async function setup(): Promise<Setup> {
  const doctor = await createDoctor(pool, { fullName: "Dra. Elena Ríos" });
  await createPublishedSite(pool, doctor, { slug: "clinica-rios", hours: URGENT });
  const patient = await createPatient(pool, { fullName: "Mario Quintana", email: "mario@example.com" });
  const result = await requestUrgent(createPatientContext(doctor.doctorId, patient.user.id), { db: pool, clock: t.clock }, { patientId: patient.patientId, category: "rojo", authorize: true });
  if (result.kind !== "scheduled") throw new Error("se esperaba una cita");
  return { doctor, patient, client: await sessionFor(t.services, patient.user), urgentId: result.id };
}

const get = (url: string, client?: AuthedClient) =>
  t.app.inject({ method: "GET", url, remoteAddress: uniqueIp(), headers: { accept: "text/html", ...(client ? { cookie: client.cookie } : {}) } });
const post = (url: string, client: AuthedClient) => postForm(t.app, url, { _csrf: client.csrf }, client.cookie);

describe("cancelar una urgencia desde Mis citas", () => {
  it("POST /pacientes/citas/:id/cancelar cancela una urgencia que empieza en menos de 24 h (303) y libera el espacio", async () => {
    const s = await setup();
    const response = await post(`/pacientes/citas/${s.urgentId}/cancelar`, s.client);
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/pacientes/citas");
    expect((await rows("SELECT status, cancelled_by_role FROM appointment WHERE id = ?", [s.urgentId]))[0]).toMatchObject({ status: "cancelled", cancelled_by_role: "patient" });
  });

  it("una cita convencional dentro del plazo sigue dando 409 cancellation_window_closed", async () => {
    const s = await setup();
    const regular = await createAppointment(pool, { doctorId: s.doctor.doctorId, patientId: s.patient.patientId, startUtc: localAt(MX, "2026-06-15", "18:00"), createdByUserId: s.patient.user.id, createdByRole: "patient" });
    const response = await post(`/pacientes/citas/${regular}/cancelar`, s.client);
    expect(response.statusCode).toBe(409);
    expect(response.body).toContain("plazo para cancelar");
    // La urgencia, en cambio, se cancela.
    expect((await post(`/pacientes/citas/${s.urgentId}/cancelar`, s.client)).statusCode).toBe(303);
  });

  it("una urgencia ya terminada responde 409 y no repite avisos", async () => {
    const s = await setup();
    t.clock.set(new Date(localAt(MX, "2026-06-15", "11:30").getTime()));
    const fresh = await sessionFor(t.services, s.patient.user);
    expect((await post(`/pacientes/citas/${s.urgentId}/cancelar`, fresh)).statusCode).toBe(409);
  });

  it("Mis citas y el detalle muestran la etiqueta «Urgencia» y el botón de cancelar hasta que empiece", async () => {
    const s = await setup();
    const list = await get("/pacientes/citas", s.client);
    expect(list.body).toContain("Urgencia");
    const detail = await get(`/pacientes/citas/${s.urgentId}`, s.client);
    expect(detail.statusCode).toBe(200);
    expect(detail.body).toContain("Urgencia");
    expect(detail.body).toContain(`action="/pacientes/citas/${s.urgentId}/cancelar"`);
    expect(detail.body).not.toContain("Ya pasó el plazo para cancelar");
    expect(detail.body.toLowerCase()).not.toMatch(/\b(rojo|naranja|amarillo|verde)\b/);
  });

  it("otra cuenta recibe 404 al ver o cancelar la urgencia", async () => {
    const s = await setup();
    const stranger = await createPatient(pool);
    const other = await sessionFor(t.services, stranger.user);
    expect((await get(`/pacientes/citas/${s.urgentId}`, other)).statusCode).toBe(404);
    expect((await post(`/pacientes/citas/${s.urgentId}/cancelar`, other)).statusCode).toBe(404);
  });
});

describe("cancelar una urgencia desde el enlace del correo", () => {
  it("el resumen muestra el botón de cancelar dentro de las 24 h y la cancelación consume el token", async () => {
    const s = await setup();
    const token = await linkTokenSentTo(t, "mario@example.com", "/citas/enlace");
    const summary = await get(`/citas/enlace/${token}`, s.client);
    expect(summary.statusCode).toBe(200);
    expect(summary.body).toContain(`action="/citas/enlace/${token}/cancelar"`);
    expect(summary.body).not.toContain("Ya pasó el plazo para cancelar");
    const response = await post(`/citas/enlace/${token}/cancelar`, s.client);
    expect(response.statusCode).toBe(303);
    expect((await rows("SELECT status FROM appointment WHERE id = ?", [s.urgentId]))[0]?.status).toBe("cancelled");
    expect((await rows("SELECT used_at FROM one_time_token"))[0]?.used_at).not.toBeNull();
    expect((await post(`/citas/enlace/${token}/cancelar`, s.client)).statusCode).toBe(410);
  });

  it("abrir el enlace nunca cambia nada, y sin sesión no cancela", async () => {
    const s = await setup();
    const token = await linkTokenSentTo(t, "mario@example.com", "/citas/enlace");
    const before = await rows("SELECT id, status FROM appointment");
    for (let index = 0; index < 5; index += 1) await get(`/citas/enlace/${token}`);
    expect(await rows("SELECT id, status FROM appointment")).toEqual(before);
    const form = await anonymousForm(t.app, `/citas/enlace/${token}`);
    const response = await postForm(t.app, `/citas/enlace/${token}/cancelar`, { _csrf: form.token }, form.cookie);
    expect(response.statusCode).toBe(303);
    expect((await rows("SELECT status FROM appointment WHERE id = ?", [s.urgentId]))[0]?.status).toBe("booked");
  });

  it("con la sesión de otra cuenta responde el 410 genérico y no cancela", async () => {
    const s = await setup();
    const token = await linkTokenSentTo(t, "mario@example.com", "/citas/enlace");
    const stranger = await createPatient(pool);
    const other = await sessionFor(t.services, stranger.user);
    expect((await post(`/citas/enlace/${token}/cancelar`, other)).statusCode).toBe(410);
    expect((await rows("SELECT status FROM appointment WHERE id = ?", [s.urgentId]))[0]?.status).toBe("booked");
  });
});
