import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TRIAGE_CONTENT } from "../../src/modules/urgent/triage-content.js";
import {
  clearTables,
  createDoctor,
  createPatient,
  createPublishedSite,
  createTestPool,
  ensurePrivacyDocument,
  resetDatabase,
  WEEKDAY_HOURS,
  type CreatedDoctor,
  type CreatedPatient,
} from "../integration/helpers/db.js";
import { createFakeCaptcha, createTestApp, sessionFor, uniqueIp, type AuthedClient, type FakeCaptcha, type TestApp } from "../integration/helpers/app.js";

const pool = createTestPool();
let development: TestApp;
let production: TestApp; // producción con claves de Turnstile (la urgencia solo depende del contenido médico)
let unconfigured: TestApp; // producción SIN claves de Turnstile
let captcha: FakeCaptcha;
const NOW = new Date("2026-06-15T14:00:00.000Z");
const URGENT_HOURS = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 14 * 60, endMinute: 16 * 60, kind: "urgent" as const }));
const PRODUCTION = { APP_ENV: "production", SMTP_HOST: "smtp.example.com", SMTP_PORT: "587", SMTP_USER: "usuario", SMTP_PASS: "clave", SMTP_FROM: "no-responder@example.com", TRUST_PROXY: "0" };
const KEYS = { TURNSTILE_SITE_KEY: "clave-publica-de-prueba", TURNSTILE_SECRET_KEY: "clave-secreta-de-prueba" };
const mutable = TRIAGE_CONTENT as { reviewedByDentist: boolean };

beforeAll(async () => {
  await resetDatabase(pool);
  captcha = createFakeCaptcha();
  development = await createTestApp(pool, {}, { captcha });
  production = await createTestApp(pool, { ...PRODUCTION, ...KEYS }, { captcha });
  unconfigured = await createTestApp(pool, PRODUCTION, { captcha: null });
});

beforeEach(async () => {
  await clearTables(pool);
  mutable.reviewedByDentist = false;
  captcha.result = "ok";
  captcha.calls.length = 0;
  for (const app of [development, production, unconfigured]) app.clock.set(NOW);
  await ensurePrivacyDocument(pool);
  for (const type of ["doctor_privacy", "terms_doctor", "reception_privacy", "reception_confidentiality"] as const) {
    await development.services.legal.publish({ type, title: type, body: "texto", isProvisional: false });
  }
});

afterAll(async () => {
  mutable.reviewedByDentist = false;
  for (const app of [development, production, unconfigured]) await app.app.close();
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
  /** Móvil de emergencias con el formato de la pantalla. */
  mobile: string;
}

async function setup(app: TestApp): Promise<Setup> {
  const doctor = await createDoctor(pool, { fullName: "Dra. Elena Ríos" });
  await createPublishedSite(pool, doctor, { slug: "clinica-rios", hours: [...WEEKDAY_HOURS, ...URGENT_HOURS] });
  const patient = await createPatient(pool, { email: `paciente${doctor.doctorId}@example.com` });
  const digits = doctor.mobile;
  return { doctor, patient, client: await sessionFor(app.services, patient.user), mobile: `${digits.slice(0, 2)} ${digits.slice(2, 6)} ${digits.slice(6)}` };
}

const get = (app: TestApp, url: string, client: AuthedClient) =>
  app.app.inject({ method: "GET", url, remoteAddress: uniqueIp(), headers: { accept: "text/html", cookie: client.cookie } });

const post = (app: TestApp, s: Setup) =>
  app.app.inject({
    method: "POST",
    url: "/c/clinica-rios/urgencia",
    remoteAddress: uniqueIp(),
    headers: { cookie: s.client.cookie, "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ _csrf: s.client.csrf, categoria: "rojo", patientId: String(s.patient.patientId), autorizo: "yes", "cf-turnstile-response": "token" }).toString(),
  });

const nothingHappened = async (): Promise<void> => {
  expect(await rows("SELECT id FROM appointment")).toEqual([]);
  expect(await rows("SELECT id FROM calendar_action_log")).toEqual([]);
  expect(await rows("SELECT id FROM email_outbox")).toEqual([]);
  expect(captcha.calls).toEqual([]);
};

describe("consultorio sin servicio en línea", () => {
  it.each([
    ["despublicado", "UPDATE doctor_site SET status = 'unpublished'"],
    ["con el médico no aprobado", "UPDATE doctor SET approval_status = 'rejected'"],
  ])("%s: GET y POST responden 403 con «confirma por teléfono» y el teléfono del consultorio; nada se asigna ni se verifica", async (_label, sql) => {
    const s = await setup(development);
    await pool.execute(sql);
    const form = await get(development, "/c/clinica-rios/urgencia", s.client);
    expect(form.statusCode).toBe(403);
    expect(form.body).toContain("Confirma directamente con el consultorio por teléfono");
    expect(form.body).toContain("55 9876 5432");
    expect(form.body).not.toContain(s.mobile); // no revela el móvil de emergencias
    const response = await post(development, s);
    expect(response.statusCode).toBe(403);
    expect(response.body).toContain("55 9876 5432");
    expect(response.body).not.toContain(s.mobile);
    await nothingHappened();
  });

  it("despublicar entre que se abre el formulario y se envía produce el mismo rechazo", async () => {
    const s = await setup(development);
    expect((await get(development, "/c/clinica-rios/urgencia", s.client)).statusCode).toBe(200);
    await pool.execute("UPDATE doctor_site SET status = 'unpublished'");
    expect((await post(development, s)).statusCode).toBe(403);
    await nothingHappened();
  });
});

describe("contenido médico provisional (constitución)", () => {
  it("en producción con el contenido provisional el flujo no se ofrece: «llama al consultorio», sin los textos del triaje", async () => {
    const s = await setup(production);
    const form = await get(production, "/c/clinica-rios/urgencia", s.client);
    expect(form.statusCode).toBe(200);
    expect(form.body).toContain("no están disponibles por ahora");
    expect(form.body).toContain("55 9876 5432");
    for (const category of TRIAGE_CONTENT.categories) expect(form.body).not.toContain(category.optionText);
    expect(form.body).not.toContain('name="categoria"');
    const response = await post(production, s);
    expect(response.statusCode).toBe(403);
    await nothingHappened();
  });

  it("con el contenido validado por un dentista (reviewedByDentist) la urgencia se ofrece en producción", async () => {
    mutable.reviewedByDentist = true;
    const s = await setup(production);
    const form = await get(production, "/c/clinica-rios/urgencia", s.client);
    expect(form.body).toContain('name="categoria"');
    expect(form.body).toContain(TRIAGE_CONTENT.version);
    expect((await post(production, s)).statusCode).toBe(303);
  });

  it("en desarrollo siempre se ofrece, con la versión del contenido a la vista", async () => {
    const s = await setup(development);
    const form = await get(development, "/c/clinica-rios/urgencia", s.client);
    expect(form.body).toContain('name="categoria"');
    expect(form.body).toContain(TRIAGE_CONTENT.version);
  });

  it("en producción sin claves de Turnstile la urgencia no se ofrece aunque el contenido esté validado", async () => {
    mutable.reviewedByDentist = true;
    const s = await setup(unconfigured);
    const form = await get(unconfigured, "/c/clinica-rios/urgencia", s.client);
    expect(form.body).toContain("no están disponibles por ahora");
    expect(form.body).not.toContain('name="categoria"');
    expect((await post(unconfigured, s)).statusCode).toBe(403);
    await nothingHappened();
  });
});

describe("el enlace «Tengo una urgencia» de la reserva", () => {
  it("aparece solo cuando el flujo está disponible", async () => {
    const dev = await setup(development);
    expect((await get(development, "/c/clinica-rios/reservar", dev.client)).body).toContain('href="/c/clinica-rios/urgencia"');
    await clearTables(pool);
    await ensurePrivacyDocument(pool);
    const prod = await setup(production);
    expect((await get(production, "/c/clinica-rios/reservar", prod.client)).body).not.toContain("/urgencia");
    mutable.reviewedByDentist = true;
    expect((await get(production, "/c/clinica-rios/reservar", prod.client)).body).toContain('href="/c/clinica-rios/urgencia"');
  });
});
