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
  type CreatedDoctor,
  type CreatedPatient,
} from "../integration/helpers/db.js";
import { createFakeCaptcha, createTestApp, sessionFor, uniqueIp, type AuthedClient, type FakeCaptcha, type TestApp } from "../integration/helpers/app.js";

const pool = createTestPool();
let t: TestApp;
let captcha: FakeCaptcha;
const NOW = new Date("2026-06-15T14:00:00.000Z");

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
  /** Móvil de emergencias con el formato de la pantalla (`55 1000 0001`). */
  mobile: string;
}

/** Consultorio SIN ningún espacio (sin franjas): toda solicitud termina sin espacio. */
async function setup(): Promise<Setup> {
  const doctor = await createDoctor(pool, { fullName: "Dra. Elena Ríos" });
  await createPublishedSite(pool, doctor, { slug: "clinica-rios", hours: [] });
  const patient = await createPatient(pool, { email: "mario@example.com" });
  const digits = doctor.mobile;
  return { doctor, patient, client: await sessionFor(t.services, patient.user), mobile: `${digits.slice(0, 2)} ${digits.slice(2, 6)} ${digits.slice(6)}` };
}

const post = (s: Setup, fields: Record<string, string | string[]>, ip?: string) => {
  const params = new URLSearchParams({ _csrf: s.client.csrf });
  for (const [key, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
  }
  return t.app.inject({
    method: "POST",
    url: "/c/clinica-rios/urgencia",
    remoteAddress: ip ?? uniqueIp(),
    headers: { cookie: s.client.cookie, "content-type": "application/x-www-form-urlencoded" },
    payload: params.toString(),
  });
};

const valid = (s: Setup, extra: Record<string, string | string[]> = {}): Record<string, string | string[]> => ({
  categoria: "rojo",
  patientId: String(s.patient.patientId),
  autorizo: "yes",
  "cf-turnstile-response": "token-de-prueba",
  ...extra,
});

describe("sin espacio", () => {
  it("muestra «No encontramos espacio», el móvil de emergencias y, en los niveles altos, el aviso de hospital; no crea nada", async () => {
    const s = await setup();
    const response = await post(s, valid(s));
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("No encontramos espacio");
    expect(response.body).toContain(s.mobile);
    expect(response.body).toContain("hospital");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(await rows("SELECT id FROM appointment")).toEqual([]);
    expect(await rows("SELECT id FROM email_outbox")).toEqual([]);
    expect(await rows("SELECT id FROM data_authorization")).toEqual([]);
  });

  it("en los niveles bajos no se muestra el aviso de hospital pero sí el móvil", async () => {
    const s = await setup();
    const response = await post(s, valid(s, { categoria: "verde" }));
    expect(response.body).toContain("No encontramos espacio");
    expect(response.body).toContain(s.mobile);
    expect(response.body).not.toContain(TRIAGE_CONTENT.hospitalNotice);
    const high = await post(s, valid(s, { categoria: "naranja" }));
    expect(high.body).toContain(TRIAGE_CONTENT.hospitalNotice);
  });

  it("si el médico no tiene móvil se muestra el teléfono del consultorio", async () => {
    const s = await setup();
    await pool.execute("UPDATE doctor SET emergency_mobile = NULL WHERE id = ?", [s.doctor.doctorId]);
    const response = await post(s, valid(s));
    expect(response.body).not.toContain(s.mobile);
    expect(response.body).toContain("55 9876 5432"); // teléfono del consultorio de los factories
  });

  it("la solicitud sin espacio deja una fila rechazada (cuenta para el límite) y la respuesta no repite la categoría", async () => {
    const s = await setup();
    const response = await post(s, valid(s, { categoria: "amarillo" }));
    expect(await rows("SELECT action, outcome FROM calendar_action_log")).toEqual([{ action: "urgent_requested", outcome: "rejected" }]);
    expect(response.body.toLowerCase()).not.toContain("amarillo");
  });
});

describe("señales de alarma", () => {
  it.each([["dificultad_respirar_tragar"], ["hinchazon_ojo"], [["dificultad_respirar_tragar", "hinchazon_ojo"]]] as const)(
    "con %s bloquea la solicitud: pantalla de emergencia, sin verificar el CAPTCHA, sin servicio, sin registros ni correos y sin contar",
    async (senales) => {
      const s = await setup();
      // Con espacio disponible: aun así la señal de alarma bloquea.
      await pool.execute("INSERT INTO calendar_hours (doctor_id, weekday, start_minute, end_minute, kind) VALUES (?, 1, 540, 600, 'urgent')", [s.doctor.doctorId]);
      const response = await post(s, valid(s, { senales: Array.isArray(senales) ? [...senales] : [senales] }));
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain(TRIAGE_CONTENT.alarmNotice);
      expect(response.body).toContain(s.mobile);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(captcha.calls).toEqual([]);
      expect(await rows("SELECT id FROM appointment")).toEqual([]);
      expect(await rows("SELECT id FROM calendar_action_log")).toEqual([]);
      expect(await rows("SELECT id FROM email_outbox")).toEqual([]);
      expect(await rows("SELECT id FROM data_authorization")).toEqual([]);
      expect(await rows("SELECT id FROM doctor_patient")).toEqual([]);
      // No repite ni la categoría ni qué señal se marcó.
      expect(response.body.toLowerCase()).not.toContain("rojo");
      expect(response.body).not.toContain("hinchazon_ojo");
    },
  );

  it("la señal de alarma no cuenta para el límite: tras tres alarmas se puede pedir una urgencia normal", async () => {
    const s = await setup();
    await pool.execute("INSERT INTO calendar_hours (doctor_id, weekday, start_minute, end_minute, kind) VALUES (?, 1, 540, 600, 'urgent')", [s.doctor.doctorId]);
    for (let index = 0; index < 4; index += 1) await post(s, valid(s, { senales: "hinchazon_ojo" }));
    expect((await post(s, valid(s))).statusCode).toBe(303);
  });

  it("una señal que no está en la lista da 400 y no deja rastro", async () => {
    const s = await setup();
    const response = await post(s, valid(s, { senales: "inventada" }));
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain("inventada");
    expect(await rows("SELECT id FROM calendar_action_log")).toEqual([]);
  });
});

describe("el móvil de emergencias no es público", () => {
  it("no aparece en el micrositio ni en la entrada, ni a quien no tiene sesión", async () => {
    const s = await setup();
    for (const url of ["/c/clinica-rios", "/c/clinica-rios/entrar", "/c/clinica-rios/primera-cita"]) {
      const response = await t.app.inject({ method: "GET", url, remoteAddress: uniqueIp(), headers: { accept: "text/html" } });
      expect(response.body, url).not.toContain(s.mobile);
      expect(response.body, url).not.toContain(s.doctor.mobile);
    }
    const anonymous = await t.app.inject({ method: "GET", url: "/c/clinica-rios/urgencia", remoteAddress: uniqueIp() });
    expect(anonymous.statusCode).toBe(303);
    expect(anonymous.body).not.toContain(s.mobile);
    // La pantalla del formulario con sesión tampoco lo muestra: solo los resultados de «sin espacio», alarma y CAPTCHA.
    const form = await t.app.inject({ method: "GET", url: "/c/clinica-rios/urgencia", remoteAddress: uniqueIp(), headers: { cookie: s.client.cookie } });
    expect(form.body).not.toContain(s.mobile);
  });
});
