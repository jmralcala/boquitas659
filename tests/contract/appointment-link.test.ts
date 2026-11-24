import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPatientContext } from "../../src/lib/tenant.js";
import { reserveAsPatient } from "../../src/modules/site/booking-service.js";
import {
  clearTables,
  createDoctor,
  createPatient,
  createPublishedSite,
  createTestPool,
  DEFAULT_TEST_PASSWORD,
  ensurePrivacyDocument,
  resetDatabase,
  type CreatedPatient,
} from "../integration/helpers/db.js";
import { anonymousForm, createTestApp, linkTokenSentTo, postForm, sessionFor, uniqueIp, type TestApp } from "../integration/helpers/app.js";

const pool = createTestPool();
let t: TestApp;

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  t.clock.set(new Date("2026-06-15T14:00:00.000Z"));
  (t.transport.sent as unknown[]).length = 0;
  await ensurePrivacyDocument(pool);
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

async function booked(): Promise<{ patient: CreatedPatient; token: string; appointmentId: number }> {
  const doctor = await createDoctor(pool, { fullName: "Dra. Elena Ríos" });
  await createPublishedSite(pool, doctor);
  const patient = await createPatient(pool, { fullName: "Mario Quintana", email: "mario@example.com" });
  const result = await reserveAsPatient(createPatientContext(doctor.doctorId, patient.user.id), { db: pool, clock: t.clock }, { startLocal: "2026-06-16T10:00", patientId: patient.patientId, authorize: true });
  return { patient, token: await linkTokenSentTo(t, "mario@example.com", "/citas/enlace"), appointmentId: result.id };
}

const get = (url: string, cookie?: string, ip?: string) =>
  t.app.inject({ method: "GET", url, remoteAddress: ip ?? uniqueIp(), headers: { accept: "text/html", ...(cookie ? { cookie } : {}) } });

describe("GET /citas/enlace/:token", () => {
  it("sin sesión muestra el inicio de sesión del paciente (sin datos de la cita) con noindex", async () => {
    const b = await booked();
    const response = await get(`/citas/enlace/${b.token}`);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('name="password"');
    expect(response.body).toContain(`action="/citas/enlace/${b.token}/entrar"`);
    expect(response.body).not.toContain("Mario Quintana");
    expect(response.body).not.toContain("Calle Falsa");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
  });

  it("con la sesión de la cuenta dueña muestra el resumen y el botón de cancelar con CSRF", async () => {
    const b = await booked();
    const client = await sessionFor(t.services, b.patient.user);
    const response = await get(`/citas/enlace/${b.token}`, client.cookie);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Mario Quintana");
    expect(response.body).toContain("Dra. Elena Ríos");
    expect(response.body).toContain("Calle Falsa 123, Centro");
    expect(response.body).toContain("10:00");
    expect(response.body).toContain(`action="/citas/enlace/${b.token}/cancelar"`);
    expect(response.body).toContain('name="_csrf"');
  });

  it("abrirlo no cambia nada: ni la cita ni el token, ni siquiera con un cliente automático", async () => {
    const b = await booked();
    const [before] = await pool.query("SELECT status FROM appointment WHERE id = ?", [b.appointmentId]);
    const [tokensBefore] = await pool.query("SELECT used_at FROM one_time_token");
    for (let index = 0; index < 30; index += 1) {
      await t.app.inject({ method: "GET", url: `/citas/enlace/${b.token}`, remoteAddress: uniqueIp(), headers: { "user-agent": "Mozilla/5.0 (antivirus-link-scanner)" } });
    }
    expect((await pool.query("SELECT status FROM appointment WHERE id = ?", [b.appointmentId]))[0]).toEqual(before);
    expect((await pool.query("SELECT used_at FROM one_time_token"))[0]).toEqual(tokensBefore);
    expect((await get(`/citas/enlace/${b.token}`)).statusCode).toBe(200);
  });

  it("otra cuenta, token manipulado, vencido, usado, de cita cancelada o ya iniciada: el mismo 410 genérico sin datos", async () => {
    const b = await booked();
    const stranger = await createPatient(pool);
    const strangerClient = await sessionFor(t.services, stranger.user);
    const responses = [
      await get(`/citas/enlace/${b.token}`, strangerClient.cookie), // otra cuenta
      await get(`/citas/enlace/${b.token.slice(0, -1)}x`), // manipulado
      await get("/citas/enlace/no-existe"),
    ];
    await pool.execute("UPDATE one_time_token SET used_at = ?", [t.clock.now()]);
    responses.push(await get(`/citas/enlace/${b.token}`)); // usado
    await pool.execute("UPDATE one_time_token SET used_at = NULL, expires_at = ?", [new Date(t.clock.now().getTime() - 1000)]);
    responses.push(await get(`/citas/enlace/${b.token}`)); // vencido
    await pool.execute("UPDATE one_time_token SET expires_at = ?", [new Date(t.clock.now().getTime() + 86_400_000)]);
    await pool.execute("UPDATE appointment SET status = 'cancelled', cancelled_at = UTC_TIMESTAMP(3)");
    responses.push(await get(`/citas/enlace/${b.token}`)); // cita cancelada
    await pool.execute("UPDATE appointment SET status = 'booked', cancelled_at = NULL");
    t.clock.set(new Date("2026-06-16T16:30:00.000Z"));
    responses.push(await get(`/citas/enlace/${b.token}`)); // la cita ya empezó

    for (const response of responses) expect(response.statusCode).toBe(410);
    const bodies = new Set(responses.map((response) => response.body));
    expect(bodies.size).toBe(1);
    const [body] = [...bodies];
    expect(body).not.toContain("Mario Quintana");
    expect(body).not.toContain("Calle Falsa");
  });

  it("limita a 60 peticiones por minuto por IP: la 61.ª recibe 429", async () => {
    const ip = uniqueIp();
    let last = 0;
    for (let index = 0; index < 61; index += 1) last = (await get("/citas/enlace/no-existe", undefined, ip)).statusCode;
    expect(last).toBe(429);
  });
});

describe("POST /citas/enlace/:token/entrar", () => {
  it("con las credenciales del paciente abre la sesión y regresa al mismo enlace", async () => {
    const b = await booked();
    const form = await anonymousForm(t.app, `/citas/enlace/${b.token}`);
    const response = await postForm(t.app, `/citas/enlace/${b.token}/entrar`, { _csrf: form.token, email: "mario@example.com", password: DEFAULT_TEST_PASSWORD }, form.cookie);
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(`/citas/enlace/${b.token}`);
    const sid = response.cookies.find((cookie) => cookie.name === "__Host-sid");
    expect(sid).toBeDefined();
    const opened = await get(`/citas/enlace/${b.token}`, `__Host-sid=${sid?.value}`);
    expect(opened.body).toContain("Mario Quintana");
  });

  it("con una contraseña incorrecta responde 401 sin sesión, y sin ofrecer crear cuenta", async () => {
    const b = await booked();
    const form = await anonymousForm(t.app, `/citas/enlace/${b.token}`);
    const response = await postForm(t.app, `/citas/enlace/${b.token}/entrar`, { _csrf: form.token, email: "mario@example.com", password: "incorrecta-123456" }, form.cookie);
    expect(response.statusCode).toBe(401);
    expect(response.cookies.find((cookie) => cookie.name === "__Host-sid")).toBeUndefined();
    expect(response.body).not.toContain("acceptPrivacy");
  });

  it("con un token que no sirve responde el mismo 410 y no intenta iniciar sesión", async () => {
    const b = await booked();
    const form = await anonymousForm(t.app, `/citas/enlace/${b.token}`);
    const response = await postForm(t.app, "/citas/enlace/no-existe/entrar", { _csrf: form.token, email: "mario@example.com", password: DEFAULT_TEST_PASSWORD }, form.cookie);
    expect(response.statusCode).toBe(410);
    expect(response.cookies.find((cookie) => cookie.name === "__Host-sid")).toBeUndefined();
  });

  it("sin token CSRF responde 403", async () => {
    const b = await booked();
    const response = await postForm(t.app, `/citas/enlace/${b.token}/entrar`, { email: "mario@example.com", password: DEFAULT_TEST_PASSWORD });
    expect(response.statusCode).toBe(403);
  });

  it("limita a 60 peticiones por minuto por IP: la 61.ª recibe 429", async () => {
    const b = await booked();
    const form = await anonymousForm(t.app, `/citas/enlace/${b.token}`);
    const ip = uniqueIp();
    let last = 0;
    for (let index = 0; index < 61; index += 1) {
      last = (await postForm(t.app, "/citas/enlace/no-existe/entrar", { _csrf: form.token, email: "x@example.com", password: "x" }, form.cookie, ip)).statusCode;
    }
    expect(last).toBe(429);
  });
});
