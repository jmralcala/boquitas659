import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTables, createDoctor, createMembership, createPatient, createTestPool, createUser, linkPatientToDoctor, resetDatabase, type CreatedDoctor } from "./helpers/db.js";
import { createTestApp, postForm, sessionFor, type AuthedClient, type TestApp } from "./helpers/app.js";

const pool = createTestPool();
let t: TestApp;
let doctorA: CreatedDoctor;
let doctorB: CreatedDoctor;

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  doctorA = await createDoctor(pool, { fullName: "Dra. A" });
  doctorB = await createDoctor(pool, { fullName: "Dr. B" });
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

interface Person {
  userId: number;
  client: AuthedClient;
  sessionId: number;
}

async function personWithSession(doctor: CreatedDoctor | null, email?: string): Promise<Person> {
  const user = await createUser(pool, { role: "reception", email });
  const client = await sessionFor(t.services, user);
  const session = await t.services.sessions.validate(client.cookie.split("=")[1] ?? "");
  if (doctor) await t.services.sessions.setActiveDoctor(session?.sessionId ?? 0, doctor.doctorId);
  return { userId: user.id, client, sessionId: session?.sessionId ?? 0 };
}

const panel = (client: AuthedClient) =>
  t.app.inject({ method: "GET", url: "/recepcion/panel", headers: { cookie: client.cookie, accept: "application/json" } });

describe("retirar a una persona de recepción", () => {
  it("corta el acceso de inmediato: la siguiente petición de una sesión abierta es rechazada", async () => {
    const person = await personWithSession(doctorA, "persona@example.com");
    const membershipId = await createMembership(pool, doctorA.doctorId, person.userId);
    expect((await panel(person.client)).statusCode).toBe(200);

    await t.services.memberships.remove(doctorA.doctorId, doctorA.user.id, membershipId);

    const response = await panel(person.client);
    expect([401, 403]).toContain(response.statusCode);
    expect(await rows("SELECT revoked_at, active_flag FROM reception_membership WHERE id = ?", [membershipId])).toMatchObject([
      { active_flag: null },
    ]);
  });

  it("solo cierra las sesiones de esa persona con ESE médico; las de otro médico siguen", async () => {
    const withA = await personWithSession(doctorA, "persona@example.com");
    await createMembership(pool, doctorA.doctorId, withA.userId);
    await createMembership(pool, doctorB.doctorId, withA.userId);
    // Misma persona, segunda sesión trabajando con el médico B.
    const second = await sessionFor(t.services, { id: withA.userId, email: "persona@example.com", role: "reception", password: "" });
    const secondSession = await t.services.sessions.validate(second.cookie.split("=")[1] ?? "");
    await t.services.sessions.setActiveDoctor(secondSession?.sessionId ?? 0, doctorB.doctorId);

    const [membership] = await rows("SELECT id FROM reception_membership WHERE doctor_id = ?", [doctorA.doctorId]);
    await t.services.memberships.remove(doctorA.doctorId, doctorA.user.id, Number(membership?.id));

    expect([401, 403]).toContain((await panel(withA.client)).statusCode);
    expect((await panel(second)).statusCode).toBe(200);
  });

  it("avisa por correo a la persona y registra la acción de quién la retiró", async () => {
    const person = await personWithSession(doctorA, "persona@example.com");
    const membershipId = await createMembership(pool, doctorA.doctorId, person.userId);
    await t.services.memberships.remove(doctorA.doctorId, doctorA.user.id, membershipId);

    await t.runOutbox();
    const email = t.transport.sent.find((m) => m.to === "persona@example.com");
    expect(email?.text).toContain("Dra. A");
    expect(await rows("SELECT actor_user_id, doctor_id, action, target_id FROM reception_action_log")).toEqual([
      { actor_user_id: doctorA.user.id, doctor_id: doctorA.doctorId, action: "remove", target_id: membershipId },
    ]);
  });

  it("un médico no puede retirar a una persona vinculada a otro médico (404)", async () => {
    const person = await personWithSession(doctorA);
    const membershipId = await createMembership(pool, doctorA.doctorId, person.userId);
    await expect(t.services.memberships.remove(doctorB.doctorId, doctorB.user.id, membershipId)).rejects.toMatchObject({ status: 404 });
    expect(await rows("SELECT active_flag FROM reception_membership WHERE id = ?", [membershipId])).toEqual([{ active_flag: 1 }]);
  });

  it("retirar dos veces la misma persona da 404 la segunda vez", async () => {
    const person = await personWithSession(doctorA);
    const membershipId = await createMembership(pool, doctorA.doctorId, person.userId);
    await t.services.memberships.remove(doctorA.doctorId, doctorA.user.id, membershipId);
    await expect(t.services.memberships.remove(doctorA.doctorId, doctorA.user.id, membershipId)).rejects.toMatchObject({ status: 404 });
  });

  it("después de retirarla se puede volver a vincular a la misma persona", async () => {
    const person = await personWithSession(doctorA);
    const membershipId = await createMembership(pool, doctorA.doctorId, person.userId);
    await t.services.memberships.remove(doctorA.doctorId, doctorA.user.id, membershipId);
    await createMembership(pool, doctorA.doctorId, person.userId);
    expect(await rows("SELECT COUNT(*) AS n FROM reception_membership WHERE active_flag = 1")).toEqual([{ n: 1 }]);
  });

  it("por HTTP: el médico retira con CSRF y es redirigido; sin CSRF no pasa nada", async () => {
    const person = await personWithSession(doctorA);
    const membershipId = await createMembership(pool, doctorA.doctorId, person.userId);
    const doctorClient = await sessionFor(t.services, doctorA.user);

    const noCsrf = await postForm(t.app, `/medicos/recepcion/${membershipId}/retirar`, {}, doctorClient.cookie);
    expect(noCsrf.statusCode).toBe(403);
    const ok = await postForm(t.app, `/medicos/recepcion/${membershipId}/retirar`, { _csrf: doctorClient.csrf }, doctorClient.cookie);
    expect(ok.statusCode).toBe(303);
    expect(ok.headers.location).toBe("/medicos/recepcion");
    expect([401, 403]).toContain((await panel(person.client)).statusCode);
  });
});

describe("revalidación del vínculo en cada petición", () => {
  it("si el vínculo se revoca fuera del servicio, la sesión abierta recibe 403 sin esperar a que caduque", async () => {
    const person = await personWithSession(doctorA);
    const membershipId = await createMembership(pool, doctorA.doctorId, person.userId);
    expect((await panel(person.client)).statusCode).toBe(200);

    await pool.execute("UPDATE reception_membership SET revoked_at = UTC_TIMESTAMP(3), active_flag = NULL WHERE id = ?", [membershipId]);
    expect((await panel(person.client)).statusCode).toBe(403);
  });

  it("si el médico deja de estar aprobado, recepción pierde el acceso a sus datos", async () => {
    const person = await personWithSession(doctorA);
    await createMembership(pool, doctorA.doctorId, person.userId);
    await pool.execute("UPDATE doctor SET approval_status = 'rejected' WHERE id = ?", [doctorA.doctorId]);
    expect((await panel(person.client)).statusCode).toBe(403);
  });
});

describe("persona con varios médicos", () => {
  it("solo ve los datos del médico activo y no puede activar uno sin vínculo vigente", async () => {
    const patientA = await createPatient(pool, { fullName: "Paciente de A" });
    const patientB = await createPatient(pool, { fullName: "Paciente de B" });
    await linkPatientToDoctor(pool, doctorA.doctorId, patientA.patientId);
    await linkPatientToDoctor(pool, doctorB.doctorId, patientB.patientId);

    const person = await personWithSession(doctorA);
    await createMembership(pool, doctorA.doctorId, person.userId);
    const html = (client: AuthedClient) => t.app.inject({ method: "GET", url: "/recepcion/panel", headers: { cookie: client.cookie } });

    // Activo A: ve solo a A.
    let body = (await html(person.client)).body;
    expect(body).toContain("Paciente de A");
    expect(body).not.toContain("Paciente de B");

    // Sin vínculo con B no puede activarlo.
    const denied = await postForm(t.app, "/recepcion/medico-activo", { doctorId: String(doctorB.doctorId), _csrf: person.client.csrf }, person.client.cookie);
    expect(denied.statusCode).toBe(403);
    body = (await html(person.client)).body;
    expect(body).not.toContain("Paciente de B");

    // Con vínculo sí; entonces ve solo a B.
    await createMembership(pool, doctorB.doctorId, person.userId);
    const ok = await postForm(t.app, "/recepcion/medico-activo", { doctorId: String(doctorB.doctorId), _csrf: person.client.csrf }, person.client.cookie);
    expect(ok.statusCode).toBe(303);
    body = (await html(person.client)).body;
    expect(body).toContain("Paciente de B");
    expect(body).not.toContain("Paciente de A");

    expect(await rows("SELECT actor_user_id, doctor_id, action FROM reception_action_log")).toEqual([
      { actor_user_id: person.userId, doctor_id: doctorB.doctorId, action: "select_active_doctor" },
    ]);
  });

  it("el selector solo ofrece los médicos con vínculo vigente", async () => {
    const person = await personWithSession(null);
    await createMembership(pool, doctorA.doctorId, person.userId);
    const response = await t.app.inject({ method: "GET", url: "/recepcion/medico-activo", headers: { cookie: person.client.cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Dra. A");
    expect(response.body).not.toContain("Dr. B");
  });

  it("rechaza un identificador de médico inválido", async () => {
    const person = await personWithSession(null);
    const response = await postForm(t.app, "/recepcion/medico-activo", { doctorId: "abc", _csrf: person.client.csrf }, person.client.cookie);
    expect(response.statusCode).toBe(400);
  });
});
