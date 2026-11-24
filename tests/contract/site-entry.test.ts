import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTables, createDoctor, createPatient, createPublishedSite, createTestPool, createUser, DEFAULT_TEST_PASSWORD, resetDatabase } from "../integration/helpers/db.js";
import { anonymousForm, createTestApp, postForm, sessionFor, uniqueIp, type TestApp } from "../integration/helpers/app.js";

const pool = createTestPool();
let t: TestApp;

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  for (const type of ["patient_privacy", "doctor_privacy", "terms_doctor", "reception_privacy", "reception_confidentiality"] as const) {
    await t.services.legal.publish({ type, title: type, body: "texto", isProvisional: false });
  }
  const doctor = await createDoctor(pool, { fullName: "Dra. Elena Ríos" });
  await createPublishedSite(pool, doctor, { slug: "clinica-rios" });
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

const setCookies = (response: { cookies: { name: string; value: string }[] }): string[] => response.cookies.map((c) => c.name);
const registration = (overrides: Record<string, string> = {}): Record<string, string> => ({
  fullName: "María López Ruiz",
  birthDate: "1990-05-17",
  email: "maria@example.com",
  phone: "5598765432",
  password: "una-contraseña-segura-2026",
  acceptPrivacy: "yes",
  ...overrides,
});

describe("GET /c/:slug/entrar y /primera-cita", () => {
  it("muestran el formulario con CSRF anónimo y la casilla de privacidad sin marcar", async () => {
    const entry = await t.app.inject({ method: "GET", url: "/c/clinica-rios/entrar", remoteAddress: uniqueIp() });
    expect(entry.statusCode).toBe(200);
    expect(entry.body).toContain('name="_csrf"');
    expect(entry.body).toContain('name="password"');
    const first = await t.app.inject({ method: "GET", url: "/c/clinica-rios/primera-cita", remoteAddress: uniqueIp() });
    expect(first.statusCode).toBe(200);
    expect(first.body).toContain('name="acceptPrivacy"');
    expect(first.body).not.toMatch(/name="acceptPrivacy"[^>]*checked/);
  });

  it("un consultorio inexistente da 404 y uno despublicado muestra el aviso sin formulario", async () => {
    expect((await t.app.inject({ method: "GET", url: "/c/no-existe/entrar", remoteAddress: uniqueIp() })).statusCode).toBe(404);
    await pool.execute("UPDATE doctor_site SET status = 'unpublished'");
    const response = await t.app.inject({ method: "GET", url: "/c/clinica-rios/primera-cita", remoteAddress: uniqueIp() });
    expect(response.body).toContain("Confirma tu cita directamente");
    expect(response.body).not.toContain('name="password"');
  });

  it("un paciente con sesión pasa directo al calendario", async () => {
    const patient = await createPatient(pool);
    const client = await sessionFor(t.services, patient.user);
    const response = await t.app.inject({ method: "GET", url: "/c/clinica-rios/entrar", remoteAddress: uniqueIp(), headers: { cookie: client.cookie } });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/c/clinica-rios/reservar");
  });
});

describe("POST /c/:slug/entrar", () => {
  it("con credenciales correctas abre la sesión y redirige a /reservar conservando solo la fecha válida", async () => {
    await createPatient(pool, { email: "ana@example.com" });
    const form = await anonymousForm(t.app, "/c/clinica-rios/entrar");
    const response = await postForm(t.app, "/c/clinica-rios/entrar", { _csrf: form.token, email: "ana@example.com", password: DEFAULT_TEST_PASSWORD, fecha: "2026-12-01" }, form.cookie);
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/c/clinica-rios/reservar?fecha=2026-12-01");
    expect(setCookies(response)).toContain("__Host-sid");
  });

  it.each(["https://malo.example/", "//malo.example", "2026-13-45", "../x", "<script>"])("ignora una fecha no válida (%s): nunca redirige fuera del consultorio", async (fecha) => {
    await createPatient(pool, { email: "ana@example.com" });
    const form = await anonymousForm(t.app, "/c/clinica-rios/entrar");
    const response = await postForm(t.app, "/c/clinica-rios/entrar", { _csrf: form.token, email: "ana@example.com", password: DEFAULT_TEST_PASSWORD, fecha }, form.cookie);
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/c/clinica-rios/reservar");
  });

  it("con contraseña incorrecta responde 401 con el mismo mensaje y sin sesión", async () => {
    await createPatient(pool, { email: "ana@example.com" });
    const form = await anonymousForm(t.app, "/c/clinica-rios/entrar");
    const response = await postForm(t.app, "/c/clinica-rios/entrar", { _csrf: form.token, email: "ana@example.com", password: "incorrecta-123456" }, form.cookie);
    expect(response.statusCode).toBe(401);
    expect(setCookies(response)).not.toContain("__Host-sid");
  });

  it("con un correo sin cuenta de paciente ofrece «Primera cita» con el correo prellenado", async () => {
    const form = await anonymousForm(t.app, "/c/clinica-rios/entrar");
    const response = await postForm(t.app, "/c/clinica-rios/entrar", { _csrf: form.token, email: "nuevo@example.com", password: "lo-que-sea-123456" }, form.cookie);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('name="acceptPrivacy"');
    expect(response.body).toContain('value="nuevo@example.com"');
  });

  it("un correo de médico no entra por el micrositio", async () => {
    await createUser(pool, { role: "doctor", email: "medico@example.com" });
    const form = await anonymousForm(t.app, "/c/clinica-rios/entrar");
    const response = await postForm(t.app, "/c/clinica-rios/entrar", { _csrf: form.token, email: "medico@example.com", password: DEFAULT_TEST_PASSWORD }, form.cookie);
    expect(setCookies(response)).not.toContain("__Host-sid");
  });

  it("sin token CSRF se rechaza", async () => {
    const response = await postForm(t.app, "/c/clinica-rios/entrar", { email: "ana@example.com", password: "x" });
    expect(response.statusCode).toBe(403);
  });

  it("limita a 10 intentos por minuto por IP", async () => {
    const ip = uniqueIp();
    const form = await anonymousForm(t.app, "/c/clinica-rios/entrar");
    let last = 0;
    for (let i = 0; i < 12; i += 1) {
      last = (await postForm(t.app, "/c/clinica-rios/entrar", { _csrf: form.token, email: `x${i}@example.com`, password: "lo-que-sea-123456" }, form.cookie, ip)).statusCode;
    }
    expect(last).toBe(429);
  });
});

describe("POST /c/:slug/primera-cita", () => {
  it("crea la cuenta, abre la sesión y redirige a /reservar", async () => {
    const form = await anonymousForm(t.app, "/c/clinica-rios/primera-cita");
    const response = await postForm(t.app, "/c/clinica-rios/primera-cita", { _csrf: form.token, ...registration(), fecha: "2026-12-01" }, form.cookie);
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/c/clinica-rios/reservar?fecha=2026-12-01");
    expect(setCookies(response)).toContain("__Host-sid");
  });

  it("sin aceptar el aviso de privacidad vuelve al formulario con el error y sin crear nada", async () => {
    const form = await anonymousForm(t.app, "/c/clinica-rios/primera-cita");
    const { acceptPrivacy: _omit, ...fields } = registration();
    void _omit;
    const response = await postForm(t.app, "/c/clinica-rios/primera-cita", { _csrf: form.token, ...fields }, form.cookie);
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("aviso de privacidad");
    const [rows] = await pool.query("SELECT id FROM `user` WHERE role = 'patient'");
    expect(rows).toEqual([]);
  });

  it("con un consultorio despublicado no crea cuentas", async () => {
    const form = await anonymousForm(t.app, "/c/clinica-rios/primera-cita");
    await pool.execute("UPDATE doctor_site SET status = 'unpublished'");
    const response = await postForm(t.app, "/c/clinica-rios/primera-cita", { _csrf: form.token, ...registration() }, form.cookie);
    expect(setCookies(response)).not.toContain("__Host-sid");
    const [rows] = await pool.query("SELECT id FROM `user` WHERE role = 'patient'");
    expect(rows).toEqual([]);
  });
});
