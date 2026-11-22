import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTenantContext } from "../../src/lib/tenant.js";
import { findPatientForDoctor, listPatientsForDoctor } from "../../src/modules/patients/patient-repository.js";
import {
  clearTables,
  createDoctor,
  createPatient,
  createTestPool,
  linkPatientToDoctor,
  resetDatabase,
} from "./helpers/db.js";

const pool = createTestPool();

beforeAll(async () => {
  await resetDatabase(pool);
});

beforeEach(async () => {
  await clearTables(pool);
});

afterAll(async () => {
  await pool.end();
});

async function scenario() {
  const doctorA = await createDoctor(pool, { fullName: "Dra. A" });
  const doctorB = await createDoctor(pool, { fullName: "Dr. B" });
  const onlyA = await createPatient(pool, { fullName: "Solo de A" });
  const onlyB = await createPatient(pool, { fullName: "Solo de B" });
  const both = await createPatient(pool, { fullName: "De A y de B" });
  const nobody = await createPatient(pool, { fullName: "Sin médico" });
  await linkPatientToDoctor(pool, doctorA.doctorId, onlyA.patientId);
  await linkPatientToDoctor(pool, doctorB.doctorId, onlyB.patientId);
  await linkPatientToDoctor(pool, doctorA.doctorId, both.patientId);
  await linkPatientToDoctor(pool, doctorB.doctorId, both.patientId);
  return {
    ctxA: createTenantContext(doctorA.doctorId, { kind: "doctor", userId: doctorA.user.id }),
    ctxB: createTenantContext(doctorB.doctorId, { kind: "doctor", userId: doctorB.user.id }),
    onlyA,
    onlyB,
    both,
    nobody,
  };
}

describe("aislamiento por médico (principio II)", () => {
  it("el listado de cada médico incluye solo a sus pacientes", async () => {
    const s = await scenario();
    expect((await listPatientsForDoctor(s.ctxA, pool)).map((p) => p.fullName).sort()).toEqual(["De A y de B", "Solo de A"]);
    expect((await listPatientsForDoctor(s.ctxB, pool)).map((p) => p.fullName).sort()).toEqual(["De A y de B", "Solo de B"]);
  });

  it("buscar por id un paciente de otro médico devuelve null, igual que uno inexistente", async () => {
    const s = await scenario();
    expect(await findPatientForDoctor(s.ctxA, pool, s.onlyB.patientId)).toBeNull();
    expect(await findPatientForDoctor(s.ctxB, pool, s.onlyA.patientId)).toBeNull();
    expect(await findPatientForDoctor(s.ctxA, pool, s.nobody.patientId)).toBeNull();
    expect(await findPatientForDoctor(s.ctxA, pool, 999999)).toBeNull();
  });

  it("un paciente vinculado a los dos médicos es visible para ambos", async () => {
    const s = await scenario();
    expect((await findPatientForDoctor(s.ctxA, pool, s.both.patientId))?.fullName).toBe("De A y de B");
    expect((await findPatientForDoctor(s.ctxB, pool, s.both.patientId))?.fullName).toBe("De A y de B");
  });

  it("sin vínculo no hay acceso", async () => {
    const s = await scenario();
    expect(await findPatientForDoctor(s.ctxA, pool, s.nobody.patientId)).toBeNull();
    expect(await findPatientForDoctor(s.ctxB, pool, s.nobody.patientId)).toBeNull();
  });

  it("devuelve la fecha de nacimiento como texto AAAA-MM-DD, sin desfase de zona horaria", async () => {
    const s = await scenario();
    const found = await findPatientForDoctor(s.ctxA, pool, s.onlyA.patientId);
    expect(found?.birthDate).toBe("1990-05-17");
  });

  it("los menores bajo un tutor se vinculan y aíslan igual que cualquier paciente", async () => {
    const doctorA = await createDoctor(pool);
    const doctorB = await createDoctor(pool);
    const tutor = await createPatient(pool);
    const [child] = await pool.execute<import("mysql2/promise").ResultSetHeader>(
      "INSERT INTO patient (account_id, full_name, birth_date, is_minor_dependent) VALUES (?, 'Menor', '2018-09-01', 1)",
      [tutor.accountId],
    );
    await linkPatientToDoctor(pool, doctorA.doctorId, child.insertId);
    const ctxA = createTenantContext(doctorA.doctorId, { kind: "doctor", userId: doctorA.user.id });
    const ctxB = createTenantContext(doctorB.doctorId, { kind: "doctor", userId: doctorB.user.id });
    expect((await findPatientForDoctor(ctxA, pool, child.insertId))?.isMinorDependent).toBe(true);
    expect(await findPatientForDoctor(ctxB, pool, child.insertId)).toBeNull();
  });
});
