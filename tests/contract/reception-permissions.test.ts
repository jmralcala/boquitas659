import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTables, createDoctor, createMembership, createPatient, createTestPool, createUser, linkPatientToDoctor, resetDatabase, type CreatedDoctor } from "../integration/helpers/db.js";
import { createTestApp, postForm, sessionFor, type AuthedClient, type TestApp } from "../integration/helpers/app.js";

const pool = createTestPool();
let t: TestApp;
let doctor: CreatedDoctor;
let reception: { client: AuthedClient; userId: number };

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  doctor = await createDoctor(pool, { fullName: "Dra. Titular" });
  const person = await createUser(pool, { role: "reception", email: "recepcion@example.com" });
  await createMembership(pool, doctor.doctorId, person.id);
  const client = await sessionFor(t.services, person);
  const session = await t.services.sessions.validate(client.cookie.split("=")[1] ?? "");
  await t.services.sessions.setActiveDoctor(session?.sessionId ?? 0, doctor.doctorId);
  reception = { client, userId: person.id };
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

function get(url: string, client: AuthedClient = reception.client) {
  return t.app.inject({ method: "GET", url, headers: { cookie: client.cookie, accept: "application/json" } });
}

describe("lo que recepción NO puede hacer (siempre 403)", () => {
  it("no entra a las pantallas del médico: invitar, panel, estado, móvil de emergencias", async () => {
    for (const url of ["/medicos/recepcion", "/medicos/panel", "/medicos/estado", "/medicos/inicio", "/cuenta/movil-emergencia"]) {
      expect((await get(url)).statusCode, url).toBe(403);
    }
  });

  it("no puede invitar a otras personas ni retirar ni revocar", async () => {
    const attempts: [string, Record<string, string>][] = [
      ["/medicos/recepcion/invitar", { email: "otra@example.com" }],
      ["/medicos/recepcion/1/retirar", {}],
      ["/medicos/recepcion/invitaciones/1/revocar", {}],
      ["/medicos/estado/reenviar", { cedulaNumber: "1234567" }],
      ["/cuenta/movil-emergencia", { currentPassword: "x", emergencyMobile: "5512345678" }],
    ];
    for (const [url, fields] of attempts) {
      const response = await postForm(t.app, url, { ...fields, _csrf: reception.client.csrf }, reception.client.cookie);
      expect(response.statusCode, url).toBe(403);
    }
    const [invitations] = await pool.query("SELECT COUNT(*) AS n FROM reception_invitation");
    expect((invitations as { n: number }[])[0]?.n).toBe(0);
  });

  it("no entra a las rutas de soporte", async () => {
    expect((await get("/soporte/medicos")).statusCode).toBe(403);
  });
});

describe("lo que recepción SÍ puede hacer", () => {
  it("ve el panel con el nombre del médico activo y los datos de contacto de sus pacientes", async () => {
    const mine = await createPatient(pool, { fullName: "Paciente de la Dra. Titular", email: "paciente1@example.com" });
    await linkPatientToDoctor(pool, doctor.doctorId, mine.patientId);

    const response = await t.app.inject({ method: "GET", url: "/recepcion/panel", headers: { cookie: reception.client.cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Dra. Titular");
    expect(response.body).toContain("Paciente de la Dra. Titular");
    expect(response.body).toContain("paciente1@example.com");
    expect(response.body).toContain("5512345678");
  });

  it("no ve pacientes de otros médicos, aunque existan", async () => {
    const otherDoctor = await createDoctor(pool);
    const theirs = await createPatient(pool, { fullName: "Paciente Ajeno", email: "ajeno@example.com" });
    await linkPatientToDoctor(pool, otherDoctor.doctorId, theirs.patientId);
    const unlinked = await createPatient(pool, { fullName: "Paciente Sin Médico" });
    expect(unlinked.patientId).toBeGreaterThan(0);

    const response = await t.app.inject({ method: "GET", url: "/recepcion/panel", headers: { cookie: reception.client.cookie } });
    expect(response.body).not.toContain("Paciente Ajeno");
    expect(response.body).not.toContain("ajeno@example.com");
    expect(response.body).not.toContain("Paciente Sin Médico");
  });

  it("con un solo médico vinculado y sin médico activo, el panel lo elige solo", async () => {
    const person = await createUser(pool, { role: "reception" });
    await createMembership(pool, doctor.doctorId, person.id);
    const client = await sessionFor(t.services, person);
    const response = await t.app.inject({ method: "GET", url: "/recepcion/panel", headers: { cookie: client.cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Dra. Titular");
  });

  it("con varios médicos y ninguno activo, pide elegir", async () => {
    const other = await createDoctor(pool);
    const person = await createUser(pool, { role: "reception" });
    await createMembership(pool, doctor.doctorId, person.id);
    await createMembership(pool, other.doctorId, person.id);
    const client = await sessionFor(t.services, person);
    const response = await t.app.inject({ method: "GET", url: "/recepcion/panel", headers: { cookie: client.cookie } });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/recepcion/medico-activo");
  });

  it("sin ningún médico vinculado el panel lo dice y no muestra datos", async () => {
    const person = await createUser(pool, { role: "reception" });
    const client = await sessionFor(t.services, person);
    const response = await t.app.inject({ method: "GET", url: "/recepcion/panel", headers: { cookie: client.cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("ningún médico vinculado");
  });

  it("solo recepción entra al panel de recepción", async () => {
    for (const role of ["patient", "doctor", "support"] as const) {
      const client = await sessionFor(t.services, await createUser(pool, { role }));
      expect((await get("/recepcion/panel", client)).statusCode, role).toBe(403);
    }
    expect((await t.app.inject({ method: "GET", url: "/recepcion/panel", headers: { accept: "application/json" } })).statusCode).toBe(401);
  });
});
