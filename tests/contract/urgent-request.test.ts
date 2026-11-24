import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  clearTables,
  createDoctor,
  createPatient,
  createPublishedSite,
  createTestPool,
  createDependent,
  ensurePrivacyDocument,
  resetDatabase,
  WEEKDAY_HOURS,
  type CreatedDoctor,
  type CreatedPatient,
} from "../integration/helpers/db.js";
import { agendaClientFor, createFakeCaptcha, createTestApp, postForm, sessionFor, uniqueIp, type AuthedClient, type FakeCaptcha, type TestApp } from "../integration/helpers/app.js";

const pool = createTestPool();
let t: TestApp;
let captcha: FakeCaptcha;
const NOW = new Date("2026-06-15T14:00:00.000Z"); // lunes 8:00 en Ciudad de México
const URGENT_HOURS = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 14 * 60, endMinute: 16 * 60, kind: "urgent" as const }));

beforeAll(async () => {
  await resetDatabase(pool);
  captcha = createFakeCaptcha();
  t = await createTestApp(pool, {}, { captcha });
});

beforeEach(async () => {
  await clearTables(pool);
  t.clock.set(NOW);
  captcha.result = "ok";
  captcha.calls.length = 0;
  await ensurePrivacyDocument(pool);
  for (const type of ["doctor_privacy", "terms_doctor", "reception_privacy", "reception_confidentiality"] as const) {
    await t.services.legal.publish({ type, title: type, body: "texto", isProvisional: false });
  }
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
  await createPublishedSite(pool, doctor, { slug: "clinica-rios", hours: [...WEEKDAY_HOURS, ...URGENT_HOURS] });
  const patient = await createPatient(pool, { fullName: "Mario Quintana", email: "mario@example.com" });
  return { doctor, patient, client: await sessionFor(t.services, patient.user) };
}

const get = (url: string, client?: AuthedClient, accept = "text/html") =>
  t.app.inject({ method: "GET", url, remoteAddress: uniqueIp(), headers: { accept, ...(client ? { cookie: client.cookie } : {}) } });

const body = (s: Setup, extra: Record<string, string> = {}): Record<string, string> => ({
  categoria: "rojo",
  patientId: String(s.patient.patientId),
  autorizo: "yes",
  "cf-turnstile-response": "token-de-prueba",
  ...extra,
});

const post = (s: Setup, fields: Record<string, string>, client: AuthedClient = s.client, ip?: string) =>
  postForm(t.app, "/c/clinica-rios/urgencia", { _csrf: client.csrf, ...fields }, client.cookie, ip);

describe("GET /c/:slug/urgencia", () => {
  it("sin sesión redirige al micrositio", async () => {
    await setup();
    const response = await get("/c/clinica-rios/urgencia");
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/c/clinica-rios");
  });

  it("con sesión muestra el formulario: señales sin marcar, 5 categorías sin valor por defecto, paciente y autorización; sin calendario", async () => {
    const s = await setup();
    const response = await get("/c/clinica-rios/urgencia", s.client);
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    for (const id of ["rojo", "naranja", "amarillo", "verde_claro", "verde"]) expect(response.body).toContain(`name="categoria" value="${id}"`);
    expect(response.body).not.toMatch(/name="categoria"[^>]*checked/);
    expect(response.body).toContain('name="senales" value="dificultad_respirar_tragar"');
    expect(response.body).toContain('name="senales" value="hinchazon_ojo"');
    expect(response.body).not.toMatch(/name="senales"[^>]*checked/);
    expect(response.body).toContain('name="patientId"');
    expect(response.body).toContain('name="autorizo"');
    expect(response.body).not.toMatch(/name="autorizo"[^>]*checked/);
    // No hay calendario ni lista de horarios.
    expect(response.body).not.toContain('name="inicio"');
    expect(response.body).not.toMatch(/\b\d{2}:\d{2}\b/);
    expect(response.body).not.toContain("fecha=");
  });

  it("en JSON tampoco devuelve horarios", async () => {
    const s = await setup();
    const response = await get("/c/clinica-rios/urgencia", s.client, "application/json");
    expect(response.statusCode).toBe(200);
    const json = response.json() as Record<string, unknown>;
    expect(JSON.stringify(json)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(json.categories).toHaveLength(5);
  });

  it("el personal y soporte con sesión reciben 403", async () => {
    const s = await setup();
    expect((await get("/c/clinica-rios/urgencia", await sessionFor(t.services, s.doctor.user))).statusCode).toBe(403);
    expect((await get("/c/clinica-rios/urgencia", (await agendaClientFor(t, pool, "reception", { doctor: s.doctor })).client)).statusCode).toBe(403);
  });

  it("un consultorio inexistente da 404", async () => {
    const s = await setup();
    expect((await get("/c/no-existe/urgencia", s.client)).statusCode).toBe(404);
  });
});

describe("POST /c/:slug/urgencia", () => {
  it("agenda el espacio más próximo y redirige al detalle de la cita; la cita queda marcada como urgencia", async () => {
    const s = await setup();
    const response = await post(s, body(s));
    expect(response.statusCode).toBe(303);
    const [appointment] = await rows("SELECT id, doctor_id, patient_id, kind, created_by_role, start_utc FROM appointment");
    expect(appointment).toMatchObject({ doctor_id: s.doctor.doctorId, patient_id: s.patient.patientId, kind: "urgent", created_by_role: "patient" });
    expect(response.headers.location).toBe(`/pacientes/citas/${appointment?.id}`);
    expect((appointment?.start_utc as Date).toISOString()).toBe("2026-06-15T15:00:00.000Z"); // lunes 9:00 locales
    expect(captcha.calls).toHaveLength(1);
  });

  it("el médico sale del enlace: un `doctorId` del cuerpo se ignora", async () => {
    const s = await setup();
    const other = await createDoctor(pool);
    await createPublishedSite(pool, other, { slug: "otro-consultorio", hours: [...WEEKDAY_HOURS, ...URGENT_HOURS] });
    const response = await post(s, body(s, { doctorId: String(other.doctorId) }));
    expect(response.statusCode).toBe(303);
    expect(await rows("SELECT id FROM appointment WHERE doctor_id = ?", [other.doctorId])).toEqual([]);
    expect(await rows("SELECT id FROM appointment WHERE doctor_id = ?", [s.doctor.doctorId])).toHaveLength(1);
  });

  it("para un paciente adicional deja la cita a su nombre", async () => {
    const s = await setup();
    const minorId = await createDependent(pool, s.patient.accountId, "Hijo de Mario");
    expect((await post(s, body(s, { patientId: String(minorId) }))).statusCode).toBe(303);
    expect((await rows("SELECT patient_id FROM appointment"))[0]?.patient_id).toBe(minorId);
  });

  it("una categoría o un paciente inválidos dan 400 y la respuesta NO repite la categoría recibida", async () => {
    const s = await setup();
    const secret = "categoria-inventada-reconocible";
    const bad = await post(s, body(s, { categoria: secret }));
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain(secret);
    expect(JSON.stringify(bad.headers)).not.toContain(secret);
    expect((await post(s, body(s, { categoria: "" }))).statusCode).toBe(400);
    expect((await post(s, { ...body(s), patientId: "abc" })).statusCode).toBe(400);
    expect(await rows("SELECT id FROM appointment")).toEqual([]);
  });

  it("sin la casilla de autorización da 400 y no crea nada; la categoría válida elegida no se repite en la respuesta", async () => {
    const s = await setup();
    const response = await post(s, body(s, { autorizo: "", categoria: "naranja" }));
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("autoriz");
    expect(response.body).not.toMatch(/name="categoria" value="naranja"[^>]*checked/);
    expect(await rows("SELECT id FROM appointment")).toEqual([]);
  });

  it("con un paciente de otra cuenta responde 404, con el micrositio despublicado 403 y sin token CSRF 403", async () => {
    const s = await setup();
    const stranger = await createPatient(pool);
    expect((await post(s, body(s, { patientId: String(stranger.patientId) }))).statusCode).toBe(404);
    expect((await postForm(t.app, "/c/clinica-rios/urgencia", body(s), s.client.cookie)).statusCode).toBe(403);
    await pool.execute("UPDATE doctor_site SET status = 'unpublished'");
    expect((await post(s, body(s))).statusCode).toBe(403);
    expect(await rows("SELECT id FROM appointment")).toEqual([]);
  });

  it("el personal con sesión recibe 403 y no se crea ninguna cita", async () => {
    const s = await setup();
    const doctorClient = await sessionFor(t.services, s.doctor.user);
    expect((await post(s, body(s), doctorClient)).statusCode).toBe(403);
    expect(await rows("SELECT id FROM appointment")).toEqual([]);
  });

  it("ni la respuesta, ni la URL de redirección ni las cookies contienen la categoría", async () => {
    for (const categoria of ["rojo", "naranja", "amarillo", "verde_claro", "verde"]) {
      await clearTables(pool);
      await ensurePrivacyDocument(pool);
      const s = await setup();
      const response = await post(s, body(s, { categoria }));
      expect(response.statusCode).toBe(303);
      const everything = JSON.stringify({ headers: response.headers, cookies: response.cookies, body: response.body });
      expect(everything.toLowerCase()).not.toContain(categoria);
    }
  });
});
