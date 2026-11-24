import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  clearTables,
  createAppointment,
  createBlock,
  createDependent,
  createDoctor,
  createPatient,
  createPublishedSite,
  createTestPool,
  resetDatabase,
  type CreatedDoctor,
} from "../integration/helpers/db.js";
import { agendaClientFor, createTestApp, localAt, postForm, sessionFor, uniqueIp, type AuthedClient, type TestApp } from "../integration/helpers/app.js";

const pool = createTestPool();
let t: TestApp;
const MX = "America/Mexico_City";
const NOW = new Date("2026-06-15T14:00:00.000Z"); // lunes 8:00 en Ciudad de México

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  t.clock.set(NOW);
  for (const type of ["patient_privacy", "doctor_privacy", "terms_doctor", "reception_privacy", "reception_confidentiality"] as const) {
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
  slug: string;
  patient: Awaited<ReturnType<typeof createPatient>>;
  client: AuthedClient;
}

async function setup(name = "Dra. Elena Ríos", slug = "clinica-rios"): Promise<Setup> {
  const doctor = await createDoctor(pool, { fullName: name });
  await createPublishedSite(pool, doctor, { slug });
  const patient = await createPatient(pool);
  return { doctor, slug, patient, client: await sessionFor(t.services, patient.user) };
}

function get(url: string, client?: AuthedClient, accept = "text/html") {
  return t.app.inject({ method: "GET", url, remoteAddress: uniqueIp(), headers: { accept, ...(client ? { cookie: client.cookie } : {}) } });
}

function post(s: Setup, url: string, fields: Record<string, string>, ip?: string) {
  return postForm(t.app, url, { _csrf: s.client.csrf, ...fields }, s.client.cookie, ip);
}

describe("GET /c/:slug/reservar", () => {
  it("sin sesión redirige al micrositio", async () => {
    await setup();
    const response = await get("/c/clinica-rios/reservar");
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/c/clinica-rios");
  });

  it("con sesión muestra el mes sin días pasados y con noindex", async () => {
    const s = await setup();
    const response = await get("/c/clinica-rios/reservar", s.client);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Dra. Elena Ríos");
    expect(response.body).toContain("junio de 2026");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    // Los enlaces del calendario llevan la hora de entrada firmada (medición del piloto, feature 5).
    expect(response.body).toContain('href="/c/clinica-rios/reservar?fecha=2026-06-16&amp;a=');
    expect(response.body).not.toContain("fecha=2026-06-14"); // pasado: no es un enlace
    expect(response.body).not.toContain("mes=2026-05"); // no se navega al pasado
    expect(response.body).toContain("mes=2026-07");
  });

  it("con `fecha` muestra los horarios libres de ese día, en la hora del consultorio, con la casilla de autorización sin marcar", async () => {
    const s = await setup();
    await createAppointment(pool, { doctorId: s.doctor.doctorId, patientId: (await createPatient(pool)).patientId, startUtc: localAt(MX, "2026-06-16", "10:00") });
    const response = await get("/c/clinica-rios/reservar?fecha=2026-06-16", s.client);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('value="2026-06-16T09:00"');
    expect(response.body).not.toContain('value="2026-06-16T10:00"'); // ocupado
    expect(response.body).toContain('name="autorizo"');
    expect(response.body).not.toMatch(/name="autorizo"[^>]*checked/);
    expect(response.body).toContain('name="patientId"');
  });

  it("una fecha pasada o mal formada responde 400", async () => {
    const s = await setup();
    for (const fecha of ["2026-06-14", "2026-02-30", "x", "2026-12-31"]) {
      expect((await get(`/c/clinica-rios/reservar?fecha=${fecha}`, s.client)).statusCode).toBe(400);
    }
  });

  it("no muestra datos de otros pacientes ni de otras cuentas", async () => {
    const s = await setup();
    const other = await createPatient(pool, { fullName: "Persona Ajena Privada" });
    await createAppointment(pool, { doctorId: s.doctor.doctorId, patientId: other.patientId, startUtc: localAt(MX, "2026-06-16", "10:00") });
    const response = await get("/c/clinica-rios/reservar?fecha=2026-06-16", s.client);
    expect(response.body).not.toContain("Persona Ajena Privada");
  });

  it("con el micrositio despublicado responde 403 con el aviso de confirmar por teléfono", async () => {
    const s = await setup();
    await pool.execute("UPDATE doctor_site SET status = 'unpublished'");
    const response = await get("/c/clinica-rios/reservar", s.client);
    expect(response.statusCode).toBe(403);
    expect(response.body).toContain("teléfono");
  });

  it("un correo de médico con sesión no entra a reservar", async () => {
    const s = await setup();
    const doctorClient = await sessionFor(t.services, s.doctor.user);
    expect((await get("/c/clinica-rios/reservar", doctorClient)).statusCode).toBe(403);
  });
});

describe("POST /c/:slug/reservar", () => {
  it("reserva y redirige al detalle de la cita; el médico sale del enlace y un `doctorId` en el cuerpo se ignora", async () => {
    const s = await setup();
    const other = await createDoctor(pool);
    await createPublishedSite(pool, other, { slug: "otro-consultorio" });
    const response = await post(s, "/c/clinica-rios/reservar", {
      inicio: "2026-06-16T10:00",
      patientId: String(s.patient.patientId),
      autorizo: "yes",
      doctorId: String(other.doctorId),
    });
    expect(response.statusCode).toBe(303);
    const [appointment] = await rows("SELECT id, doctor_id, patient_id, created_by_role FROM appointment");
    expect(appointment).toMatchObject({ doctor_id: s.doctor.doctorId, patient_id: s.patient.patientId, created_by_role: "patient" });
    expect(response.headers.location).toBe(`/pacientes/citas/${appointment?.id}`);
    expect(await rows("SELECT id FROM appointment WHERE doctor_id = ?", [other.doctorId])).toEqual([]);
  });

  it("un horario ya ocupado responde 409 slot_unavailable con los horarios actualizados", async () => {
    const s = await setup();
    const other = await createPatient(pool);
    await createAppointment(pool, { doctorId: s.doctor.doctorId, patientId: other.patientId, startUtc: localAt(MX, "2026-06-16", "10:00") });
    const response = await post(s, "/c/clinica-rios/reservar", { inicio: "2026-06-16T10:00", patientId: String(s.patient.patientId), autorizo: "yes" });
    expect(response.statusCode).toBe(409);
    expect(response.body).toContain("ya no está disponible");
    expect(response.body).toContain('value="2026-06-16T09:00"');
    expect(response.body).not.toContain('value="2026-06-16T10:00"');
    expect(await rows("SELECT id FROM data_authorization")).toEqual([]);
  });

  it("el horario que el navegador ofreció pero que ya está bloqueado se rechaza", async () => {
    const s = await setup();
    await createBlock(pool, { doctorId: s.doctor.doctorId, startUtc: localAt(MX, "2026-06-16", "10:00"), endUtc: localAt(MX, "2026-06-16", "11:00") });
    expect((await post(s, "/c/clinica-rios/reservar", { inicio: "2026-06-16T10:00", patientId: String(s.patient.patientId), autorizo: "yes" })).statusCode).toBe(409);
  });

  it("responde 400 con un horario inexistente o sin la casilla de autorización", async () => {
    const s = await setup();
    expect((await post(s, "/c/clinica-rios/reservar", { inicio: "2026-06-16T10:30", patientId: String(s.patient.patientId), autorizo: "yes" })).statusCode).toBe(400);
    const noBox = await post(s, "/c/clinica-rios/reservar", { inicio: "2026-06-16T10:00", patientId: String(s.patient.patientId) });
    expect(noBox.statusCode).toBe(400);
    expect(noBox.body).toContain("autoriz");
    expect(await rows("SELECT id FROM appointment")).toEqual([]);
  });

  it("responde 400 con un paciente mal formado", async () => {
    const s = await setup();
    expect((await post(s, "/c/clinica-rios/reservar", { inicio: "2026-06-16T10:00", patientId: "abc", autorizo: "yes" })).statusCode).toBe(400);
  });

  it("responde 403 con el micrositio despublicado y 404 con un paciente de otra cuenta", async () => {
    const s = await setup();
    const stranger = await createPatient(pool);
    expect((await post(s, "/c/clinica-rios/reservar", { inicio: "2026-06-16T10:00", patientId: String(stranger.patientId), autorizo: "yes" })).statusCode).toBe(404);
    await pool.execute("UPDATE doctor_site SET status = 'unpublished'");
    expect((await post(s, "/c/clinica-rios/reservar", { inicio: "2026-06-16T10:00", patientId: String(s.patient.patientId), autorizo: "yes" })).statusCode).toBe(403);
  });

  it("sin token CSRF se rechaza con 403", async () => {
    const s = await setup();
    const response = await postForm(t.app, "/c/clinica-rios/reservar", { inicio: "2026-06-16T10:00", patientId: String(s.patient.patientId), autorizo: "yes" }, s.client.cookie);
    expect(response.statusCode).toBe(403);
    expect(await rows("SELECT id FROM appointment")).toEqual([]);
  });

  it("el doble envío del mismo formulario da 303 a la cita ya creada, sin duplicar", async () => {
    const s = await setup();
    const fields = { inicio: "2026-06-16T10:00", patientId: String(s.patient.patientId), autorizo: "yes" };
    const first = await post(s, "/c/clinica-rios/reservar", fields);
    const second = await post(s, "/c/clinica-rios/reservar", fields);
    expect(first.statusCode).toBe(303);
    expect(second.statusCode).toBe(303);
    expect(second.headers.location).toBe(first.headers.location);
    expect(await rows("SELECT id FROM appointment")).toHaveLength(1);
  });

  it("la sexta reserva en una hora de la misma cuenta responde 429 con Retry-After", async () => {
    const s = await setup();
    const dependents = [await createDependent(pool, s.patient.accountId, "Hijo Uno"), await createDependent(pool, s.patient.accountId, "Hijo Dos")];
    const ids = [s.patient.patientId, ...dependents];
    const slots = ["2026-06-17T10:00", "2026-06-17T11:00", "2026-06-17T12:00", "2026-06-17T13:00", "2026-06-17T16:00", "2026-06-17T17:00"];
    const statuses: number[] = [];
    let last = await post(s, "/c/clinica-rios/reservar", { inicio: slots[0] ?? "", patientId: String(ids[0]), autorizo: "yes" });
    statuses.push(last.statusCode);
    for (const [index, inicio] of slots.slice(1).entries()) {
      last = await post(s, "/c/clinica-rios/reservar", { inicio, patientId: String(ids[(index + 1) % 3]), autorizo: "yes" });
      statuses.push(last.statusCode);
    }
    expect(statuses.slice(0, 5)).toEqual([303, 303, 303, 303, 303]);
    expect(last.statusCode).toBe(429);
    expect(Number(last.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("limita las peticiones de reserva a 20 por hora por IP", async () => {
    const s = await setup();
    const ip = uniqueIp();
    let last = 0;
    for (let index = 0; index < 22; index += 1) {
      last = (await post(s, "/c/clinica-rios/reservar", { inicio: "2026-06-16T10:30", patientId: String(s.patient.patientId), autorizo: "yes" }, ip)).statusCode;
    }
    expect(last).toBe(429);
  });
});

describe("pacientes adicionales desde el micrositio", () => {
  it("GET muestra el formulario y POST añade al menor y regresa a reservar", async () => {
    const s = await setup();
    expect((await get("/c/clinica-rios/paciente-adicional", s.client)).body).toContain('name="acceptPrivacyOnBehalf"');
    const response = await post(s, "/c/clinica-rios/paciente-adicional", {
      fullName: "Hijo de Prueba",
      birthDate: "2018-03-01",
      phone: "5512345678",
      acceptPrivacyOnBehalf: "yes",
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/c/clinica-rios/reservar");
    expect(await rows("SELECT full_name FROM patient WHERE account_id = ? AND is_minor_dependent = 1", [s.patient.accountId])).toEqual([{ full_name: "Hijo de Prueba" }]);
  });

  it("sin aceptar el aviso en nombre del menor responde 400 y no crea nada", async () => {
    const s = await setup();
    const response = await post(s, "/c/clinica-rios/paciente-adicional", { fullName: "Hijo de Prueba", birthDate: "2018-03-01" });
    expect(response.statusCode).toBe(400);
    expect(await rows("SELECT id FROM patient WHERE is_minor_dependent = 1")).toEqual([]);
  });

  it("el menor aparece como opción al reservar y la cita queda a su nombre", async () => {
    const s = await setup();
    const minorId = await createDependent(pool, s.patient.accountId, "Hijo de Prueba");
    expect((await get("/c/clinica-rios/reservar?fecha=2026-06-16", s.client)).body).toContain("Hijo de Prueba");
    const response = await post(s, "/c/clinica-rios/reservar", { inicio: "2026-06-16T10:00", patientId: String(minorId), autorizo: "yes" });
    expect(response.statusCode).toBe(303);
    expect((await rows("SELECT patient_id FROM appointment"))[0]?.patient_id).toBe(minorId);
  });
});

describe("la agenda del médico (feature 2) muestra quién agendó", () => {
  it("el detalle de la cita indica que la creó el paciente", async () => {
    const s = await setup();
    await post(s, "/c/clinica-rios/reservar", { inicio: "2026-06-16T10:00", patientId: String(s.patient.patientId), autorizo: "yes" });
    const [appointment] = await rows("SELECT id FROM appointment");
    const doctor = await agendaClientFor(t, pool, "doctor", { doctor: s.doctor });
    const json = await get(`/agenda/citas/${appointment?.id}`, doctor.client, "application/json");
    expect(json.statusCode).toBe(200);
    expect(json.json()).toMatchObject({ createdByRole: "patient" });
    const html = await get(`/agenda/citas/${appointment?.id}`, doctor.client);
    expect(html.body).toContain("el paciente");
    expect(html.body).toContain("Agendada por");
  });
});
