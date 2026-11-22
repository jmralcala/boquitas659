import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTables, createDoctor, createMembership, createPatient, createTestPool, createUser, linkPatientToDoctor, resetDatabase, type CreatedDoctor } from "../integration/helpers/db.js";
import { createTestApp, sessionFor, type AuthedClient, type TestApp } from "../integration/helpers/app.js";

const pool = createTestPool();
let t: TestApp;
let doctor: CreatedDoctor;
let doctorClient: AuthedClient;

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  doctor = await createDoctor(pool, { fullName: "Dra. Titular" });
  doctorClient = await sessionFor(t.services, doctor.user);
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

function detail(patientId: number | string, client: AuthedClient, json = true) {
  return t.app.inject({ method: "GET", url: `/agenda/pacientes/${patientId}`, headers: { cookie: client.cookie, ...(json ? { accept: "application/json" } : {}) } });
}

async function linkedPatient(options: { fullName?: string; birthDate?: string; email?: string } = {}) {
  const patient = await createPatient(pool, { fullName: "Ana Pérez", birthDate: "1990-05-17", email: "ana@example.com", ...options });
  await linkPatientToDoctor(pool, doctor.doctorId, patient.patientId);
  return patient;
}

describe("detalle de un paciente del médico", () => {
  it("devuelve nombre, teléfono, correo y edad calculada (no la guardada), y registra el acceso", async () => {
    const patient = await linkedPatient();
    t.clock.set(new Date("2026-06-15T18:00:00.000Z"));

    const response = await detail(patient.patientId, doctorClient);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: patient.patientId,
      fullName: "Ana Pérez",
      phone: "5512345678",
      email: "ana@example.com",
      age: 36,
      isMinorDependent: false,
      tutor: null,
    });

    const log = await rows("SELECT actor_user_id, actor_role, doctor_id, patient_id, outcome FROM patient_access_log");
    expect(log).toEqual([
      { actor_user_id: doctor.user.id, actor_role: "doctor", doctor_id: doctor.doctorId, patient_id: patient.patientId, outcome: "allowed" },
    ]);
  });

  it("para un menor incluye también al tutor", async () => {
    const tutor = await createPatient(pool, { fullName: "Tutora Prueba", birthDate: "1985-03-10", email: "tutora@example.com" });
    const [child] = await pool.execute<import("mysql2/promise").ResultSetHeader>(
      "INSERT INTO patient (account_id, full_name, birth_date, phone, is_minor_dependent) VALUES (?, 'Mateo Pérez', '2018-09-01', NULL, 1)",
      [tutor.accountId],
    );
    await linkPatientToDoctor(pool, doctor.doctorId, child.insertId);
    t.clock.set(new Date("2026-06-15T18:00:00.000Z"));

    const response = await detail(child.insertId, doctorClient);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      fullName: "Mateo Pérez",
      age: 7,
      isMinorDependent: true,
      tutor: { fullName: "Tutora Prueba", phone: "5512345678", email: "tutora@example.com" },
    });
  });

  it("el tutor solo se ve a través del menor vinculado con este médico: sin ese vínculo es un 404", async () => {
    const tutor = await createPatient(pool);
    const [child] = await pool.execute<import("mysql2/promise").ResultSetHeader>(
      "INSERT INTO patient (account_id, full_name, birth_date, is_minor_dependent) VALUES (?, 'Menor ajeno', '2018-09-01', 1)",
      [tutor.accountId],
    );
    expect((await detail(child.insertId, doctorClient)).statusCode).toBe(404);
  });

  it("también sirve HTML para navegadores, con los datos escapados", async () => {
    const patient = await linkedPatient({ fullName: "<script>x</script>" });
    const response = await detail(patient.patientId, doctorClient, false);
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("<script>x</script>");
    expect(response.body).toContain("&lt;script&gt;");
    expect(response.body).toMatch(/\d+ años/);
  });
});

describe("pacientes que no son del médico", () => {
  it("un paciente de otro médico y uno inexistente dan exactamente el mismo 404, y ambos intentos quedan registrados como denegados", async () => {
    const other = await createDoctor(pool);
    const theirs = await createPatient(pool);
    await linkPatientToDoctor(pool, other.doctorId, theirs.patientId);

    const foreign = await detail(theirs.patientId, doctorClient);
    const missing = await detail(999999, doctorClient);
    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(foreign.body).toBe(missing.body);

    const log = await rows("SELECT actor_user_id, doctor_id, patient_id, outcome FROM patient_access_log ORDER BY id");
    expect(log).toEqual([
      { actor_user_id: doctor.user.id, doctor_id: doctor.doctorId, patient_id: theirs.patientId, outcome: "denied" },
      { actor_user_id: doctor.user.id, doctor_id: doctor.doctorId, patient_id: 999999, outcome: "denied" },
    ]);
  });

  it("un identificador que no es numérico da 400 y no registra nada", async () => {
    expect((await detail("abc", doctorClient)).statusCode).toBe(400);
    expect(await rows("SELECT COUNT(*) AS n FROM patient_access_log")).toEqual([{ n: 0 }]);
  });
});

describe("recepción", () => {
  async function receptionClient(doctorId: number | null) {
    const person = await createUser(pool, { role: "reception" });
    if (doctorId !== null) await createMembership(pool, doctorId, person.id);
    const client = await sessionFor(t.services, person);
    const session = await t.services.sessions.validate(client.cookie.split("=")[1] ?? "");
    if (doctorId !== null) await t.services.sessions.setActiveDoctor(session?.sessionId ?? 0, doctorId);
    return { person, client };
  }

  it("accede solo con su médico activo y el acceso queda registrado a nombre de la persona de recepción", async () => {
    const patient = await linkedPatient();
    const { person, client } = await receptionClient(doctor.doctorId);
    expect((await detail(patient.patientId, client)).statusCode).toBe(200);
    expect(await rows("SELECT actor_user_id, actor_role, doctor_id, outcome FROM patient_access_log")).toEqual([
      { actor_user_id: person.id, actor_role: "reception", doctor_id: doctor.doctorId, outcome: "allowed" },
    ]);
  });

  it("no ve pacientes de otro médico aunque trabaje con él en otra sesión", async () => {
    const other = await createDoctor(pool);
    const theirs = await createPatient(pool);
    await linkPatientToDoctor(pool, other.doctorId, theirs.patientId);
    const { client } = await receptionClient(doctor.doctorId);
    expect((await detail(theirs.patientId, client)).statusCode).toBe(404);
  });

  it("sin médico activo o con el vínculo retirado recibe 403 y no se registra acceso", async () => {
    const patient = await linkedPatient();
    const noDoctor = await receptionClient(null);
    expect((await detail(patient.patientId, noDoctor.client)).statusCode).toBe(403);

    const revoked = await receptionClient(doctor.doctorId);
    await pool.execute("UPDATE reception_membership SET revoked_at = UTC_TIMESTAMP(3), active_flag = NULL WHERE reception_user_id = ?", [revoked.person.id]);
    expect((await detail(patient.patientId, revoked.client)).statusCode).toBe(403);
    expect(await rows("SELECT COUNT(*) AS n FROM patient_access_log")).toEqual([{ n: 0 }]);
  });
});

describe("otros roles y sin sesión", () => {
  it("pacientes y soporte reciben 403 y sin sesión 401", async () => {
    const patient = await linkedPatient();
    const patientClient = await sessionFor(t.services, patient.user);
    expect((await detail(patient.patientId, patientClient)).statusCode).toBe(403);
    expect((await t.app.inject({ method: "GET", url: `/agenda/pacientes/${patient.patientId}`, headers: { accept: "application/json" } })).statusCode).toBe(401);
  });

  it("un médico pendiente no accede a datos de pacientes", async () => {
    const pending = await createDoctor(pool, { status: "pending" });
    const client = await sessionFor(t.services, pending.user);
    const patient = await createPatient(pool);
    await linkPatientToDoctor(pool, pending.doctorId, patient.patientId);
    expect((await detail(patient.patientId, client)).statusCode).toBe(403);
  });
});

describe("el registro de accesos no guarda contenido", () => {
  it("la tabla solo tiene identificadores, resultado y fecha", async () => {
    const columns = await rows("SELECT column_name AS name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'patient_access_log' ORDER BY ordinal_position");
    expect(columns.map((c) => String(c.name))).toEqual(["id", "actor_user_id", "actor_role", "doctor_id", "patient_id", "outcome", "occurred_at"]);
  });

  it("tras un acceso no aparece ningún dato del paciente en el registro", async () => {
    const patient = await linkedPatient({ fullName: "Nombre Muy Reconocible", email: "reconocible@example.com" });
    await detail(patient.patientId, doctorClient);
    const dump = JSON.stringify(await rows("SELECT * FROM patient_access_log"));
    expect(dump).not.toContain("Reconocible");
    expect(dump).not.toContain("reconocible@example.com");
    expect(dump).not.toContain("5512345678");
  });
});
