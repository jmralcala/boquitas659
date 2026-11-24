import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  clearTables,
  createDependent,
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

// Esta app lleva claves de Turnstile (widget y token obligatorios); la de urgent-request.test.ts va sin ellas (desarrollo).
const pool = createTestPool();
let t: TestApp;
let captcha: FakeCaptcha;
const NOW = new Date("2026-06-15T14:00:00.000Z");
const URGENT_HOURS = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 14 * 60, endMinute: 16 * 60, kind: "urgent" as const }));
const KEYS = { TURNSTILE_SITE_KEY: "clave-publica-de-prueba", TURNSTILE_SECRET_KEY: "clave-secreta-de-prueba" };

beforeAll(async () => {
  await resetDatabase(pool);
  captcha = createFakeCaptcha();
  t = await createTestApp(pool, KEYS, { captcha });
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

async function setup(hours: NonNullable<NonNullable<Parameters<typeof createPublishedSite>[2]>["hours"]> = [...WEEKDAY_HOURS, ...URGENT_HOURS]): Promise<Setup> {
  const doctor = await createDoctor(pool, { fullName: "Dra. Elena Ríos" });
  await createPublishedSite(pool, doctor, { slug: "clinica-rios", hours });
  const patient = await createPatient(pool, { email: "mario@example.com" });
  return { doctor, patient, client: await sessionFor(t.services, patient.user) };
}

const post = (s: Setup, fields: Record<string, string>, options: { ip?: string; client?: AuthedClient } = {}) => {
  const client = options.client ?? s.client;
  return t.app.inject({
    method: "POST",
    url: "/c/clinica-rios/urgencia",
    remoteAddress: options.ip ?? uniqueIp(),
    headers: { cookie: client.cookie, "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ _csrf: client.csrf, ...fields }).toString(),
  });
};

const valid = (s: Setup, extra: Record<string, string> = {}): Record<string, string> => ({
  categoria: "rojo",
  patientId: String(s.patient.patientId),
  autorizo: "yes",
  "cf-turnstile-response": "token-de-prueba",
  ...extra,
});

describe("CAPTCHA", () => {
  it("un token inválido da 400 `captcha_invalid`, no busca espacio, no crea nada y NO cuenta como solicitud", async () => {
    const s = await setup();
    captcha.result = "invalid";
    const response = await post(s, valid(s));
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("No pudimos verificar");
    expect(await rows("SELECT id FROM appointment")).toEqual([]);
    expect(await rows("SELECT id FROM calendar_action_log")).toEqual([]);
    // Como no contó, el siguiente intento válido pasa.
    captcha.result = "ok";
    expect((await post(s, valid(s))).statusCode).toBe(303);
  });

  it("falla cerrado: con el CAPTCHA no disponible muestra el móvil de emergencias y el teléfono del consultorio, sin cita ni solicitud", async () => {
    const s = await setup();
    captcha.result = "unavailable";
    const response = await post(s, valid(s));
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("No pudimos verificar");
    const mobile = s.doctor.mobile;
    expect(response.body).toContain(`${mobile.slice(0, 2)} ${mobile.slice(2, 6)} ${mobile.slice(6)}`);
    expect(response.body).toContain("55 9876 5432");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(await rows("SELECT id FROM appointment")).toEqual([]);
    expect(await rows("SELECT id FROM calendar_action_log")).toEqual([]);
    expect(await rows("SELECT id FROM data_authorization")).toEqual([]);
  });

  it("con claves configuradas, un token ausente o de más de 2048 caracteres da 400 sin llamar al verificador", async () => {
    const s = await setup();
    const missing = await post(s, valid(s, { "cf-turnstile-response": "" }));
    expect(missing.statusCode).toBe(400);
    const { "cf-turnstile-response": _omitted, ...withoutToken } = valid(s);
    void _omitted;
    expect((await post(s, withoutToken)).statusCode).toBe(400);
    expect((await post(s, valid(s, { "cf-turnstile-response": "a".repeat(2049) }))).statusCode).toBe(400);
    expect(captcha.calls).toEqual([]);
    expect(await rows("SELECT id FROM appointment")).toEqual([]);
  });

  it("el verificador recibe solo el token y la IP del visitante (nunca la categoría ni datos del paciente)", async () => {
    const s = await setup();
    const ip = uniqueIp();
    await post(s, valid(s, { categoria: "naranja" }), { ip });
    expect(captcha.calls).toEqual([{ token: "token-de-prueba", ip }]);
    expect(JSON.stringify(captcha.calls)).not.toContain("naranja");
    expect(JSON.stringify(captcha.calls)).not.toContain("mario@example.com");
  });

  it("el formulario incluye el widget de Turnstile y amplía la CSP solo en esta ruta", async () => {
    const s = await setup();
    const form = await t.app.inject({ method: "GET", url: "/c/clinica-rios/urgencia", remoteAddress: uniqueIp(), headers: { cookie: s.client.cookie, accept: "text/html" } });
    expect(form.body).toContain('class="cf-turnstile"');
    expect(form.body).toContain('data-sitekey="clave-publica-de-prueba"');
    expect(String(form.headers["content-security-policy"])).toContain("https://challenges.cloudflare.com");
    const other = await t.app.inject({ method: "GET", url: "/c/clinica-rios/reservar", remoteAddress: uniqueIp(), headers: { cookie: s.client.cookie, accept: "text/html" } });
    expect(String(other.headers["content-security-policy"])).not.toContain("challenges.cloudflare.com");
    const site = await t.app.inject({ method: "GET", url: "/c/clinica-rios", remoteAddress: uniqueIp(), headers: { accept: "text/html" } });
    expect(String(site.headers["content-security-policy"])).not.toContain("challenges.cloudflare.com");
  });
});

describe("límites", () => {
  it("una urgencia vigente: la segunda del mismo paciente da 409 urgent_active; con otro paciente de la cuenta pasa", async () => {
    const s = await setup();
    const minorId = await createDependent(pool, s.patient.accountId, "Hijo de Mario");
    expect((await post(s, valid(s))).statusCode).toBe(303);
    t.clock.advance(3 * 60_000);
    const fresh = await sessionFor(t.services, s.patient.user);
    const second = await post(s, valid(s), { client: fresh });
    expect(second.statusCode).toBe(409);
    expect(second.body).toContain("urgencia vigente");
    expect((await post(s, valid(s, { patientId: String(minorId) }), { client: fresh })).statusCode).toBe(303);
  });

  it("tres solicitudes en 24 h (con o sin espacio): la cuarta da 429 con Retry-After; pasadas 24 h se permite", async () => {
    const s = await setup([]);
    for (let index = 0; index < 3; index += 1) expect((await post(s, valid(s))).statusCode).toBe(200); // sin espacio
    const fourth = await post(s, valid(s));
    expect(fourth.statusCode).toBe(429);
    expect(Number(fourth.headers["retry-after"])).toBeGreaterThan(0);
    t.clock.advance(24 * 3_600_000 + 1000);
    const fresh = await sessionFor(t.services, s.patient.user);
    expect((await post(s, valid(s), { client: fresh })).statusCode).toBe(200);
  });

  it("el doble envío del mismo formulario da 303 a la misma cita, sin segunda cita y sin contar dos veces", async () => {
    const s = await setup();
    const first = await post(s, valid(s));
    const second = await post(s, valid(s));
    expect(first.statusCode).toBe(303);
    expect(second.statusCode).toBe(303);
    expect(second.headers.location).toBe(first.headers.location);
    expect(await rows("SELECT id FROM appointment")).toHaveLength(1);
    expect(await rows("SELECT id FROM calendar_action_log WHERE action = 'urgent_requested'")).toHaveLength(1);
  });

  it("más de 10 solicitudes por hora desde una IP: la 11.ª da 429 con Retry-After (aunque sean solicitudes inválidas)", async () => {
    const s = await setup();
    const ip = uniqueIp();
    let last = await post(s, valid(s, { categoria: "inventada" }), { ip });
    for (let index = 0; index < 10; index += 1) last = await post(s, valid(s, { categoria: "inventada" }), { ip });
    expect(last.statusCode).toBe(429);
    expect(Number(last.headers["retry-after"])).toBeGreaterThan(0);
    expect(await rows("SELECT id FROM appointment")).toEqual([]);
  });

  it("las pantallas se limitan a 120 por minuto por IP", async () => {
    const s = await setup();
    const ip = uniqueIp();
    let last = 0;
    for (let index = 0; index < 121; index += 1) {
      last = (await t.app.inject({ method: "GET", url: "/c/clinica-rios/urgencia", remoteAddress: ip, headers: { cookie: s.client.cookie, accept: "text/html" } })).statusCode;
    }
    expect(last).toBe(429);
  });
});
