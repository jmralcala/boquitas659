import { Writable } from "node:stream";
import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expireUrgentCategories } from "../../src/jobs/urgent-notices.js";
import { CATEGORY_IDS } from "../../src/modules/urgent/triage-content.js";
import {
  clearTables,
  createDoctor,
  createPatient,
  createPublishedSite,
  createTestPool,
  ensurePrivacyDocument,
  resetDatabase,
  type CreatedDoctor,
  type CreatedPatient,
} from "./helpers/db.js";
import { createFakeCaptcha, createTestApp, postForm, sessionFor, uniqueIp, type AuthedClient, type FakeCaptcha, type TestApp } from "./helpers/app.js";

// Constitución I: la categoría y las señales de alarma no se guardan ni se registran fuera de la cola de envío.
const pool = createTestPool();
let t: TestApp;
let captcha: FakeCaptcha;
let captured = "";
const NOW = new Date("2026-06-15T14:00:00.000Z");
const HOUR = 3_600_000;
const URGENT = [{ weekday: 1, startMinute: 10 * 60, endMinute: 17 * 60, kind: "urgent" as const }];
const SECRETS = { name: "Persona Reconocible Quiroz", email: "reconocible.urgencia@example.com", phone: "5598761111", token: "token-captcha-reconocible" };
let counter = 0;
const CATEGORY_PATTERN = new RegExp(`(${CATEGORY_IDS.join("|")})`);

beforeAll(async () => {
  await resetDatabase(pool);
  captcha = createFakeCaptcha();
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      captured += String(chunk);
      callback();
    },
  });
  t = await createTestApp(pool, {}, { captcha, logStream: stream });
});

beforeEach(async () => {
  await clearTables(pool);
  captured = "";
  t.clock.set(NOW);
  captcha.result = "ok";
  captcha.calls.length = 0;
  (t.transport.sent as unknown[]).length = 0;
  t.transport.failNext(0);
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

async function setup(hours: NonNullable<NonNullable<Parameters<typeof createPublishedSite>[2]>["hours"]> = URGENT): Promise<Setup> {
  const doctor = await createDoctor(pool);
  await createPublishedSite(pool, doctor, { slug: `consultorio-${doctor.doctorId}`, hours });
  counter += 1;
  // Correo único por paciente que CONTIENE el valor reconocible, para buscarlo en los registros.
  const patient = await createPatient(pool, { fullName: SECRETS.name, email: `${counter}.${SECRETS.email}` });
  await pool.execute("UPDATE patient SET phone = ? WHERE id = ?", [SECRETS.phone, patient.patientId]);
  return { doctor, patient, client: await sessionFor(t.services, patient.user) };
}

const post = (s: Setup, fields: Record<string, string | string[]>) => {
  const params = new URLSearchParams({ _csrf: s.client.csrf });
  for (const [key, value] of Object.entries(fields)) for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
  return t.app.inject({
    method: "POST",
    url: `/c/consultorio-${s.doctor.doctorId}/urgencia`,
    remoteAddress: uniqueIp(),
    headers: { cookie: s.client.cookie, "content-type": "application/x-www-form-urlencoded" },
    payload: params.toString(),
  });
};

const fields = (s: Setup, category: string, extra: Record<string, string | string[]> = {}): Record<string, string | string[]> => ({
  categoria: category,
  patientId: String(s.patient.patientId),
  autorizo: "yes",
  "cf-turnstile-response": SECRETS.token,
  ...extra,
});

/** Volcado de TODAS las tablas de la base (menos las indicadas) como texto. */
async function dumpTables(except: string[] = []): Promise<Record<string, string>> {
  const tables = await rows("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'");
  const dump: Record<string, string> = {};
  for (const table of tables) {
    const name = String(table.name);
    if (except.includes(name)) continue;
    dump[name] = JSON.stringify(await rows(`SELECT * FROM \`${name}\``));
  }
  return dump;
}

describe("la categoría no queda guardada fuera de la cola de envío", () => {
  it("con la urgencia agendada y el aviso aún en cola, SOLO el payload de ese aviso contiene la categoría", async () => {
    for (const category of CATEGORY_IDS) {
      await clearTables(pool);
      await ensurePrivacyDocument(pool);
      const s = await setup();
      expect((await post(s, fields(s, category))).statusCode).toBe(303);
      const others = await dumpTables(["email_outbox"]);
      for (const [name, text] of Object.entries(others)) expect(text, `${category} en ${name}`).not.toMatch(CATEGORY_PATTERN);
      const outbox = await rows("SELECT template, status, payload_ref FROM email_outbox");
      const withCategory = outbox.filter((row) => CATEGORY_PATTERN.test(String(row.payload_ref)));
      expect(withCategory).toHaveLength(1);
      expect(withCategory[0]?.template).toBe("doctor_urgent_notice");
      expect(withCategory[0]?.status).toBe("queued");
    }
  });

  it("tras recorrer todos los flujos ninguna tabla, registro técnico ni correo al paciente contiene la categoría, las señales ni el token", async () => {
    // Urgencias de cada categoría (cada una con su médico), entregadas.
    for (const category of CATEGORY_IDS) {
      const s = await setup();
      await post(s, fields(s, category));
    }
    // Sin espacio, alarma, CAPTCHA inválido y no disponible, límites y errores de validación.
    const noSpace = await setup([]);
    await post(noSpace, fields(noSpace, "naranja"));
    await post(noSpace, fields(noSpace, "rojo", { senales: ["hinchazon_ojo", "dificultad_respirar_tragar"] }));
    captcha.result = "invalid";
    await post(noSpace, fields(noSpace, "amarillo"));
    captcha.result = "unavailable";
    await post(noSpace, fields(noSpace, "verde"));
    captcha.result = "ok";
    await post(noSpace, fields(noSpace, "categoria-inventada-reconocible"));
    await post(noSpace, fields(noSpace, "verde_claro", { senales: "inventada" }));
    // Entrega de los avisos (se borra la categoría) y expiración de uno que se quedó en cola.
    await t.runOutbox();
    const expiring = await setup();
    await post(expiring, fields(expiring, "rojo"));
    t.clock.set(new Date(NOW.getTime() + 25 * HOUR));
    await expireUrgentCategories(pool, t.clock);
    await t.runOutbox();
    // Cancelación por el paciente de una urgencia.
    const cancelling = await setup();
    const scheduled = await post(cancelling, fields(cancelling, "naranja"));
    const location = String(scheduled.headers.location);
    await t.app.inject({ method: "GET", url: location, remoteAddress: uniqueIp(), headers: { cookie: cancelling.client.cookie } });
    await postForm(t.app, `${location}/cancelar`, { _csrf: cancelling.client.csrf }, cancelling.client.cookie);
    await t.runOutbox();

    // 1. Ninguna tabla guarda la categoría (todas las filas del outbox ya están en un estado final).
    for (const [name, text] of Object.entries(await dumpTables())) expect(text, `tabla ${name}`).not.toMatch(CATEGORY_PATTERN);
    // 2. Los registros técnicos no llevan la categoría, las señales, el token ni datos del paciente.
    expect(captured.length).toBeGreaterThan(0);
    for (const secret of [...CATEGORY_IDS, "dificultad_respirar_tragar", "hinchazon_ojo", SECRETS.token, SECRETS.email, SECRETS.name, SECRETS.phone, "categoria-inventada-reconocible"]) {
      expect(captured, `registro técnico: «${secret}»`).not.toContain(secret);
    }
    // 3. Los correos al paciente (y los avisos genéricos) no contienen la categoría.
    const toPatients = t.transport.sent.filter((message) => message.to.endsWith(SECRETS.email) || message.subject === "Tienes una urgencia agendada");
    expect(toPatients.length).toBeGreaterThan(0);
    for (const message of toPatients) expect(`${message.subject}\n${message.text}`.toLowerCase()).not.toMatch(/\b(rojo|naranja|amarillo|verde)\b/);
    // 4. El verificador solo vio el token y la IP.
    for (const call of captcha.calls) expect(Object.keys(call).sort()).toEqual(["ip", "token"]);
  });

  it("la señal de alarma no deja rastro: ni tablas, ni registros, ni correos", async () => {
    const s = await setup();
    await post(s, fields(s, "rojo", { senales: "dificultad_respirar_tragar" }));
    for (const [name, text] of Object.entries(await dumpTables())) expect(text, `tabla ${name}`).not.toMatch(/dificultad_respirar_tragar|hinchazon_ojo/);
    expect(await rows("SELECT id FROM calendar_action_log")).toEqual([]);
    expect(await rows("SELECT id FROM email_outbox")).toEqual([]);
    expect(captured).not.toContain("dificultad_respirar_tragar");
  });
});
