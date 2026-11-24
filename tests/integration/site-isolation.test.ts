import { readdirSync, readFileSync } from "node:fs";
import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
} from "./helpers/db.js";
import { agendaClientFor, createTestApp, localAt, postForm, sessionFor, uniqueIp, type AuthedClient, type TestApp } from "./helpers/app.js";

const pool = createTestPool();
let t: TestApp;
const MX = "America/Mexico_City";
const NOW = new Date("2026-06-15T14:00:00.000Z");

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  t.clock.set(NOW);
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

interface World {
  doctorA: CreatedDoctor;
  doctorB: CreatedDoctor;
  alice: CreatedPatient;
  bob: CreatedPatient;
  aliceClient: AuthedClient;
  bobClient: AuthedClient;
  aliceAppointment: number;
}

async function world(): Promise<World> {
  const doctorA = await createDoctor(pool, { fullName: "Dra. Elena Ríos" });
  const doctorB = await createDoctor(pool, { fullName: "Dr. Otro Consultorio" });
  await createPublishedSite(pool, doctorA, { slug: "clinica-rios" });
  await createPublishedSite(pool, doctorB, { slug: "otro-consultorio" });
  const alice = await createPatient(pool, { fullName: "Alicia Privada Reconocible", email: "alicia@example.com" });
  const bob = await createPatient(pool, { fullName: "Beto Privado Reconocible", email: "beto@example.com" });
  const aliceAppointment = await createAppointment(pool, { doctorId: doctorA.doctorId, patientId: alice.patientId, startUtc: localAt(MX, "2026-06-18", "10:00"), createdByUserId: alice.user.id, createdByRole: "patient" });
  return { doctorA, doctorB, alice, bob, aliceClient: await sessionFor(t.services, alice.user), bobClient: await sessionFor(t.services, bob.user), aliceAppointment };
}

const get = (url: string, client?: AuthedClient) =>
  t.app.inject({ method: "GET", url, remoteAddress: uniqueIp(), headers: { accept: "text/html", ...(client ? { cookie: client.cookie } : {}) } });
const post = (url: string, client: AuthedClient, fields: Record<string, string> = {}) => postForm(t.app, url, { _csrf: client.csrf, ...fields }, client.cookie);

describe("un paciente no alcanza los datos de otra cuenta", () => {
  it("no ve, cancela ni revoca citas o vínculos ajenos (404 con ids ajenos)", async () => {
    const w = await world();
    expect((await get(`/pacientes/citas/${w.aliceAppointment}`, w.bobClient)).statusCode).toBe(404);
    expect((await post(`/pacientes/citas/${w.aliceAppointment}/cancelar`, w.bobClient)).statusCode).toBe(404);
    expect((await post(`/pacientes/consultorios/${w.doctorA.doctorId}/revocar`, w.bobClient)).statusCode).toBe(404);
    expect((await get(`/pacientes/consultorios/${w.doctorA.doctorId}/revocar`, w.bobClient)).statusCode).toBe(404);
    expect((await get("/pacientes/citas", w.bobClient)).body).not.toContain("Alicia Privada Reconocible");
    expect((await get("/pacientes/consultorios", w.bobClient)).body).not.toContain("Dra. Elena Ríos");
    expect((await rows("SELECT status FROM appointment WHERE id = ?", [w.aliceAppointment]))[0]?.status).toBe("booked");
    expect(await rows("SELECT id FROM doctor_patient WHERE revoked_at IS NOT NULL")).toEqual([]);
  });

  it("un patientId o doctorId manipulado no cambia a quién se reserva", async () => {
    const w = await world();
    const foreign = await post("/c/clinica-rios/reservar", w.bobClient, { inicio: "2026-06-19T10:00", patientId: String(w.alice.patientId), autorizo: "yes" });
    expect(foreign.statusCode).toBe(404);
    const redirected = await post("/c/clinica-rios/reservar", w.bobClient, { inicio: "2026-06-19T10:00", patientId: String(w.bob.patientId), autorizo: "yes", doctorId: String(w.doctorB.doctorId) });
    expect(redirected.statusCode).toBe(303);
    expect(await rows("SELECT doctor_id, patient_id FROM appointment WHERE patient_id = ?", [w.bob.patientId])).toEqual([{ doctor_id: w.doctorA.doctorId, patient_id: w.bob.patientId }]);
  });

  it("agregar un paciente adicional siempre cuelga de la cuenta de quien tiene la sesión", async () => {
    const w = await world();
    await post("/c/clinica-rios/paciente-adicional", w.bobClient, { fullName: "Hijo de Beto", birthDate: "2018-03-01", acceptPrivacyOnBehalf: "yes", accountId: String(w.alice.accountId) });
    expect(await rows("SELECT account_id FROM patient WHERE full_name = 'Hijo de Beto'")).toEqual([{ account_id: w.bob.accountId }]);
  });
});

describe("el micrositio público no devuelve datos de pacientes", () => {
  it("ni nombres, ni correos, ni horarios ocupados, con sesión o sin ella", async () => {
    const w = await world();
    for (const url of ["/c/clinica-rios", "/c/clinica-rios/entrar", "/c/clinica-rios/primera-cita", "/c/clinica-rios/logo"]) {
      for (const client of [undefined, w.bobClient]) {
        const response = await get(url, client);
        expect(response.body, url).not.toContain("Alicia Privada Reconocible");
        expect(response.body, url).not.toContain("alicia@example.com");
      }
    }
    const day = await get("/c/clinica-rios/reservar?fecha=2026-06-18", w.bobClient);
    expect(day.body).not.toContain("Alicia");
    expect(day.body).not.toContain('value="2026-06-18T10:00"'); // el horario ocupado no se ofrece
  });
});

describe("cada rol queda en su lado", () => {
  it("el personal con sesión no reserva (403) y el paciente no entra a la agenda ni a Mi micrositio (403)", async () => {
    const w = await world();
    const doctor = await sessionFor(t.services, w.doctorA.user);
    const reception = (await agendaClientFor(t, pool, "reception", { doctor: w.doctorA })).client;
    for (const staff of [doctor, reception]) {
      expect((await post("/c/clinica-rios/reservar", staff, { inicio: "2026-06-19T10:00", patientId: String(w.alice.patientId), autorizo: "yes" })).statusCode).toBe(403);
      expect((await get("/c/clinica-rios/reservar", staff)).statusCode).toBe(403);
      expect((await get("/pacientes/citas", staff)).statusCode).toBe(403);
    }
    for (const url of ["/agenda", "/agenda/configuracion", "/agenda/bloqueos", `/agenda/citas/${w.aliceAppointment}`, `/agenda/pacientes/${w.alice.patientId}`, "/medicos/micrositio"]) {
      expect((await get(url, w.aliceClient)).statusCode, url).toBe(403);
    }
    expect(await rows("SELECT id FROM appointment")).toHaveLength(1);
  });
});

describe("las funciones de src/modules/site/ reciben el contexto o están justificadas", () => {
  // Funciones que NO reciben el contexto y por qué: son fábricas, utilidades sin datos de un médico, rutas, o funciones de
  // CUENTA que derivan el contexto ellas mismas de un registro verificado (nunca de un dato que mande el cliente).
  const EXEMPT: Readonly<Record<string, string>> = {
    changeSiteSlug: "procedimiento de soporte por script (sin sesión): cambia el nombre del enlace de un micrositio",
    changeSlugAsSupport: "soporte no es un tenant: cambia el nombre del enlace de un micrositio (panel y script)",
    recordBookingStarted: "contador diario agregado por médico del piloto: solo conteos, sin datos de pacientes",
    recordBookingCompleted: "contador diario agregado por médico del piloto: solo conteos, sin datos de pacientes",
    createAppointmentLinks: "fábrica",
    createEntryService: "fábrica",
    createLogoStorage: "fábrica",
    createSiteResolver: "fábrica: es la ÚNICA vía que produce el contexto de paciente desde el nombre del enlace",
    detectLogoType: "pura: bytes",
    findSiteBySlug: "lectura pública por nombre del enlace: solo nombre, teléfono, dirección y estado",
    registerSiteDoctorRoutes: "rutas",
    registerSitePatientRoutes: "rutas",
    registerSitePublicRoutes: "rutas",
    resolveDoctorOnly: "resolutor del médico (produce el contexto)",
    listAppointmentsForPatients: "por cuenta: ids de listAccountPatientIds de la cuenta con sesión",
    findAppointmentForPatients: "por cuenta: ids de listAccountPatientIds de la cuenta con sesión",
    countPatientCancellations: "por cuenta de quien tiene la sesión",
    listOffices: "por cuenta de quien tiene la sesión",
    previewRevocation: "por cuenta: crea el contexto tras comprobar el vínculo activo de la cuenta",
    revoke: "por cuenta: crea el contexto tras comprobar el vínculo activo de la cuenta",
    listForAccount: "por cuenta de quien tiene la sesión",
    getForAccount: "por cuenta de quien tiene la sesión",
    cancelAsPatient: "por cuenta: el médico sale de la cita de una persona de la cuenta",
  };

  it("toda función exportada recibe ctx como primer parámetro o está en la lista justificada", () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const name of readdirSync("src/modules/site").filter((file) => file.endsWith(".ts"))) {
      const source = readFileSync(`src/modules/site/${name}`, "utf8");
      for (const match of source.matchAll(/export (?:async )?function (\w+)(?:<[^>]*>)?\(\s*([^)]*)\)/g)) {
        checked += 1;
        const fn = match[1] as string;
        if (/^ctx: (?:Staff|Tenant)Context\b/.test((match[2] ?? "").trim())) continue;
        if (!(fn in EXEMPT)) offenders.push(`${name}: ${fn}`);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(30);
    expect(offenders).toEqual([]);
  });

  it("la lista justificada no tiene entradas que ya no existen", () => {
    const all = readdirSync("src/modules/site")
      .filter((file) => file.endsWith(".ts"))
      .map((file) => readFileSync(`src/modules/site/${file}`, "utf8"))
      .join("\n");
    for (const fn of Object.keys(EXEMPT)) expect(all, fn).toMatch(new RegExp(`export (?:async )?function ${fn}\\b`));
  });
});
