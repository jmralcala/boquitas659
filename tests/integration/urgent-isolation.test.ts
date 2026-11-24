import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPatientContext } from "../../src/lib/tenant.js";
import { requestUrgent } from "../../src/modules/urgent/urgent-service.js";
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
} from "./helpers/db.js";
import { agendaClientFor, createFakeCaptcha, createSupportWithMfa, createTestApp, postForm, sessionFor, uniqueIp, type AuthedClient, type TestApp } from "./helpers/app.js";

const pool = createTestPool();
let t: TestApp;
const NOW = new Date("2026-06-15T14:00:00.000Z");
const URGENT_HOURS = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 14 * 60, endMinute: 16 * 60, kind: "urgent" as const }));

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool, {}, { captcha: createFakeCaptcha() });
});

beforeEach(async () => {
  await clearTables(pool);
  t.clock.set(NOW);
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

interface World {
  doctorA: CreatedDoctor;
  doctorB: CreatedDoctor;
  alice: CreatedPatient;
  bob: CreatedPatient;
  aliceClient: AuthedClient;
  bobClient: AuthedClient;
  aliceUrgent: number;
}

async function world(): Promise<World> {
  const doctorA = await createDoctor(pool, { fullName: "Dra. Elena Ríos" });
  const doctorB = await createDoctor(pool, { fullName: "Dr. Otro Consultorio" });
  const hours = [...WEEKDAY_HOURS, ...URGENT_HOURS];
  await createPublishedSite(pool, doctorA, { slug: "clinica-rios", hours });
  await createPublishedSite(pool, doctorB, { slug: "otro-consultorio", hours });
  const alice = await createPatient(pool, { fullName: "Alicia Privada Reconocible", email: "alicia@example.com" });
  const bob = await createPatient(pool, { fullName: "Beto Privado Reconocible", email: "beto@example.com" });
  const result = await requestUrgent(createPatientContext(doctorA.doctorId, alice.user.id), { db: pool, clock: t.clock }, { patientId: alice.patientId, category: "naranja", authorize: true });
  if (result.kind !== "scheduled") throw new Error("se esperaba una cita");
  return { doctorA, doctorB, alice, bob, aliceClient: await sessionFor(t.services, alice.user), bobClient: await sessionFor(t.services, bob.user), aliceUrgent: result.id };
}

const get = (url: string, client: AuthedClient, accept = "text/html") =>
  t.app.inject({ method: "GET", url, remoteAddress: uniqueIp(), headers: { accept, cookie: client.cookie } });

const postUrgent = (slug: string, client: AuthedClient, fields: Record<string, string>) =>
  postForm(t.app, `/c/${slug}/urgencia`, { _csrf: client.csrf, categoria: "rojo", autorizo: "yes", "cf-turnstile-response": "token", ...fields }, client.cookie);

describe("las urgencias respetan el aislamiento entre cuentas y consultorios", () => {
  it("un paciente no ve ni cancela la urgencia de otra cuenta (404)", async () => {
    const w = await world();
    expect((await get(`/pacientes/citas/${w.aliceUrgent}`, w.bobClient)).statusCode).toBe(404);
    expect((await postForm(t.app, `/pacientes/citas/${w.aliceUrgent}/cancelar`, { _csrf: w.bobClient.csrf }, w.bobClient.cookie)).statusCode).toBe(404);
    expect((await get("/pacientes/citas", w.bobClient)).body).not.toContain("Alicia Privada Reconocible");
    expect((await rows("SELECT status FROM appointment WHERE id = ?", [w.aliceUrgent]))[0]?.status).toBe("booked");
  });

  it("un patientId de otra cuenta da 404 y no agenda; un doctorId del cuerpo no cambia el consultorio", async () => {
    const w = await world();
    expect((await postUrgent("clinica-rios", w.bobClient, { patientId: String(w.alice.patientId) })).statusCode).toBe(404);
    const response = await postUrgent("clinica-rios", w.bobClient, { patientId: String(w.bob.patientId), doctorId: String(w.doctorB.doctorId) });
    expect(response.statusCode).toBe(303);
    expect(await rows("SELECT doctor_id FROM appointment WHERE patient_id = ?", [w.bob.patientId])).toEqual([{ doctor_id: w.doctorA.doctorId }]);
    expect(await rows("SELECT id FROM appointment WHERE doctor_id = ?", [w.doctorB.doctorId])).toEqual([]);
  });

  it("el médico de otro consultorio no ve la urgencia (404 en su agenda)", async () => {
    const w = await world();
    const other = await agendaClientFor(t, pool, "doctor", { doctor: w.doctorB });
    expect((await get(`/agenda/citas/${w.aliceUrgent}`, other.client, "application/json")).statusCode).toBe(404);
    const own = await agendaClientFor(t, pool, "doctor", { doctor: w.doctorA });
    expect((await get(`/agenda/citas/${w.aliceUrgent}`, own.client, "application/json")).statusCode).toBe(200);
  });

  it("el micrositio y sus rutas públicas no devuelven datos de pacientes ni sus urgencias", async () => {
    const w = await world();
    for (const url of ["/c/clinica-rios", "/c/clinica-rios/entrar", "/c/clinica-rios/primera-cita"]) {
      const response = await t.app.inject({ method: "GET", url, remoteAddress: uniqueIp(), headers: { accept: "text/html" } });
      expect(response.body, url).not.toContain("Alicia Privada Reconocible");
      expect(response.body, url).not.toContain("alicia@example.com");
      expect(response.body.toLowerCase(), url).not.toContain("naranja");
    }
    // El formulario de urgencia de otro paciente tampoco lista a otras cuentas.
    expect((await get("/c/clinica-rios/urgencia", w.bobClient)).body).not.toContain("Alicia");
  });
});

describe("cada rol queda en su lado", () => {
  it("el médico, la recepción y soporte con sesión reciben 403 en el formulario y en la solicitud, y no se crea nada", async () => {
    const w = await world();
    const doctor = await sessionFor(t.services, w.doctorA.user);
    const reception = (await agendaClientFor(t, pool, "reception", { doctor: w.doctorA })).client;
    const support = await sessionFor(t.services, await createSupportWithMfa(t, pool));
    const before = (await rows("SELECT id FROM appointment")).length;
    for (const client of [doctor, reception, support]) {
      expect((await get("/c/clinica-rios/urgencia", client)).statusCode).toBe(403);
      expect((await postUrgent("clinica-rios", client, { patientId: String(w.bob.patientId) })).statusCode).toBe(403);
    }
    expect(await rows("SELECT id FROM appointment")).toHaveLength(before);
  });

  it("un paciente con sesión no entra a la agenda ni a Mi micrositio (403)", async () => {
    const w = await world();
    for (const url of ["/agenda", "/agenda/configuracion", `/agenda/citas/${w.aliceUrgent}`, "/medicos/micrositio"]) {
      expect((await get(url, w.aliceClient)).statusCode, url).toBe(403);
    }
  });

  it("sin sesión no se pide una urgencia: el formulario redirige y la solicitud se rechaza", async () => {
    await world();
    const anonymous = await t.app.inject({ method: "GET", url: "/c/clinica-rios/urgencia", remoteAddress: uniqueIp() });
    expect(anonymous.statusCode).toBe(303);
    const post = await postForm(t.app, "/c/clinica-rios/urgencia", { categoria: "rojo" });
    expect(post.statusCode).toBe(403); // sin token CSRF
  });
});
