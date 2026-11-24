import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NotFoundError } from "../../src/http/errors.js";
import { createPatientContext, createTenantContext, type StaffContext, type TenantContext } from "../../src/lib/tenant.js";
import { linkPatientToDoctor } from "../../src/modules/patients/link-service.js";
import {
  accountHasRevokedLink,
  findNotificationEmailForDoctor,
  findPatientForDoctor,
  findPatientOfAccount,
  findTutorForMinor,
  listAccountPatientIds,
  listAccountPatientIdsLinkedToDoctor,
  listPatientNamesForDoctor,
  listPatientsForDoctor,
  revokeAccountLinks,
} from "../../src/modules/patients/patient-repository.js";
import { clearTables, createDoctor, createPatient, createTestPool, resetDatabase } from "./helpers/db.js";

const pool = createTestPool();
const NOW = new Date("2026-06-15T18:00:00.000Z");

beforeAll(async () => {
  await resetDatabase(pool);
});

beforeEach(async () => {
  await clearTables(pool);
});

afterAll(async () => {
  await pool.end();
});

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

async function scenario(): Promise<{ staff: StaffContext; patientCtx: TenantContext; doctorId: number; owner: Awaited<ReturnType<typeof createPatient>>; minorId: number }> {
  const doctor = await createDoctor(pool);
  const owner = await createPatient(pool, { fullName: "Titular Uno", email: "titular@example.com" });
  const [minor] = await pool.execute<import("mysql2/promise").ResultSetHeader>(
    "INSERT INTO patient (account_id, full_name, birth_date, is_minor_dependent) VALUES (?, 'Menor Uno', '2018-03-01', 1)",
    [owner.accountId],
  );
  const staff = createTenantContext(doctor.doctorId, { kind: "doctor", userId: doctor.user.id });
  const patientCtx = createPatientContext(doctor.doctorId, owner.user.id);
  return { staff, patientCtx, doctorId: doctor.doctorId, owner, minorId: minor.insertId };
}

describe("vínculos nuevos", () => {
  it("guardan el origen y quién los creó, y son idempotentes (no cambian el origen del primero)", async () => {
    const s = await scenario();
    await linkPatientToDoctor(s.staff, pool, s.owner.patientId, { origin: "office", createdByUserId: s.staff.actor.userId });
    await linkPatientToDoctor(s.patientCtx, pool, s.owner.patientId, { origin: "patient", createdByUserId: s.owner.user.id });
    expect(await rows("SELECT origin, created_by_user_id, revoked_at FROM doctor_patient")).toEqual([
      { origin: "office", created_by_user_id: s.staff.actor.userId, revoked_at: null },
    ]);
  });

  it("sin opciones el vínculo es del consultorio", async () => {
    const s = await scenario();
    await linkPatientToDoctor(s.staff, pool, s.owner.patientId);
    expect((await rows("SELECT origin FROM doctor_patient"))[0]?.origin).toBe("office");
  });

  it("devuelve si creó el vínculo, para decidir si hay que avisar al paciente", async () => {
    const s = await scenario();
    expect(await linkPatientToDoctor(s.staff, pool, s.owner.patientId)).toMatchObject({ created: true, reactivated: false });
    expect(await linkPatientToDoctor(s.staff, pool, s.owner.patientId)).toMatchObject({ created: false, reactivated: false });
  });

  it("un paciente o un médico inexistente lanza NotFoundError", async () => {
    const s = await scenario();
    await expect(linkPatientToDoctor(s.staff, pool, 9_999_999)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("revocación", () => {
  it("revokeAccountLinks marca revocados todos los vínculos de la cuenta con ese médico (titular y menores) y solo esos", async () => {
    const s = await scenario();
    const other = await createDoctor(pool);
    const otherCtx = createTenantContext(other.doctorId, { kind: "doctor", userId: other.user.id });
    await linkPatientToDoctor(s.staff, pool, s.owner.patientId);
    await linkPatientToDoctor(s.staff, pool, s.minorId);
    await linkPatientToDoctor(otherCtx, pool, s.owner.patientId);

    expect(await revokeAccountLinks(s.staff, pool, s.owner.accountId, NOW)).toBe(2);
    const state = await rows("SELECT doctor_id, patient_id, revoked_at FROM doctor_patient ORDER BY doctor_id, patient_id");
    expect(state.filter((row) => row.doctor_id === s.doctorId).every((row) => row.revoked_at instanceof Date)).toBe(true);
    expect(state.filter((row) => row.doctor_id === other.doctorId).every((row) => row.revoked_at === null)).toBe(true);
    expect(await revokeAccountLinks(s.staff, pool, s.owner.accountId, NOW)).toBe(0); // segunda vez: nada que revocar
  });

  it("tras revocar, el contacto desaparece de todas las lecturas del consultorio", async () => {
    const s = await scenario();
    await linkPatientToDoctor(s.staff, pool, s.owner.patientId);
    await linkPatientToDoctor(s.staff, pool, s.minorId);
    expect(await findPatientForDoctor(s.staff, pool, s.owner.patientId)).not.toBeNull();
    expect(await findTutorForMinor(s.staff, pool, s.minorId)).not.toBeNull();
    expect(await findNotificationEmailForDoctor(s.patientCtx, pool, s.owner.patientId)).toBe("titular@example.com");

    await revokeAccountLinks(s.staff, pool, s.owner.accountId, NOW);

    expect(await findPatientForDoctor(s.staff, pool, s.owner.patientId)).toBeNull();
    expect(await findPatientForDoctor(s.staff, pool, s.minorId)).toBeNull();
    expect(await listPatientsForDoctor(s.staff, pool)).toEqual([]);
    expect(await findTutorForMinor(s.staff, pool, s.minorId)).toBeNull();
    expect(await findNotificationEmailForDoctor(s.patientCtx, pool, s.owner.patientId)).toBeNull();
  });

  it("los nombres de las citas pasadas siguen disponibles tras revocar (solo el nombre)", async () => {
    const s = await scenario();
    await linkPatientToDoctor(s.staff, pool, s.owner.patientId);
    await revokeAccountLinks(s.staff, pool, s.owner.accountId, NOW);
    const names = await listPatientNamesForDoctor(s.staff, pool, [s.owner.patientId]);
    expect(names.get(s.owner.patientId)).toBe("Titular Uno");
  });

  it("la revocación de un médico no afecta a los datos que ve otro", async () => {
    const s = await scenario();
    const other = await createDoctor(pool);
    const otherCtx = createTenantContext(other.doctorId, { kind: "doctor", userId: other.user.id });
    await linkPatientToDoctor(s.staff, pool, s.owner.patientId);
    await linkPatientToDoctor(otherCtx, pool, s.owner.patientId);
    await revokeAccountLinks(s.staff, pool, s.owner.accountId, NOW);
    expect(await findPatientForDoctor(otherCtx, pool, s.owner.patientId)).not.toBeNull();
  });
});

describe("el personal no puede reactivar un vínculo revocado", () => {
  it("vincular desde el consultorio a quien revocó lanza NotFoundError y no cambia nada", async () => {
    const s = await scenario();
    await linkPatientToDoctor(s.staff, pool, s.owner.patientId);
    await revokeAccountLinks(s.staff, pool, s.owner.accountId, NOW);
    const before = await rows("SELECT * FROM doctor_patient");
    await expect(linkPatientToDoctor(s.staff, pool, s.owner.patientId, { origin: "office", createdByUserId: s.staff.actor.userId })).rejects.toBeInstanceOf(NotFoundError);
    expect(await rows("SELECT * FROM doctor_patient")).toEqual(before);
  });

  it("tampoco puede vincular a otro paciente de la misma cuenta (un menor) mientras la cuenta tenga la revocación", async () => {
    const s = await scenario();
    await linkPatientToDoctor(s.staff, pool, s.owner.patientId);
    await revokeAccountLinks(s.staff, pool, s.owner.accountId, NOW);
    expect(await accountHasRevokedLink(s.staff, pool, s.minorId)).toBe(true);
    await expect(linkPatientToDoctor(s.staff, pool, s.minorId)).rejects.toBeInstanceOf(NotFoundError);
    expect(await rows("SELECT id FROM doctor_patient WHERE patient_id = ?", [s.minorId])).toEqual([]);
  });

  it("una cuenta sin revocaciones no se ve afectada", async () => {
    const s = await scenario();
    expect(await accountHasRevokedLink(s.staff, pool, s.owner.patientId)).toBe(false);
  });
});

describe("el propio paciente reactiva el vínculo", () => {
  it("con origen patient se reactivan todos los vínculos revocados de la cuenta con ese médico y se conserva el historial", async () => {
    const s = await scenario();
    await linkPatientToDoctor(s.staff, pool, s.owner.patientId);
    await linkPatientToDoctor(s.staff, pool, s.minorId);
    await revokeAccountLinks(s.staff, pool, s.owner.accountId, NOW);

    const result = await linkPatientToDoctor(s.patientCtx, pool, s.owner.patientId, { origin: "patient", createdByUserId: s.owner.user.id });
    expect(result).toMatchObject({ created: false, reactivated: true });
    const state = await rows("SELECT patient_id, origin, created_by_user_id, revoked_at FROM doctor_patient ORDER BY patient_id");
    expect(state).toHaveLength(2); // no se duplican filas
    expect(state.every((row) => row.revoked_at === null && row.origin === "patient" && row.created_by_user_id === s.owner.user.id)).toBe(true);
    expect(await findPatientForDoctor(s.staff, pool, s.owner.patientId)).not.toBeNull();
    // Y a partir de ahí el personal sí puede agendarlo de nuevo.
    await expect(linkPatientToDoctor(s.staff, pool, s.minorId)).resolves.toBeDefined();
  });

  it("si el paciente que reserva no tenía fila (otro menor de la cuenta), se crea con origen patient", async () => {
    const s = await scenario();
    await linkPatientToDoctor(s.staff, pool, s.owner.patientId);
    await revokeAccountLinks(s.staff, pool, s.owner.accountId, NOW);
    await linkPatientToDoctor(s.patientCtx, pool, s.minorId, { origin: "patient", createdByUserId: s.owner.user.id });
    expect(await rows("SELECT patient_id, origin, revoked_at FROM doctor_patient ORDER BY patient_id")).toEqual([
      { patient_id: s.owner.patientId, origin: "patient", revoked_at: null },
      { patient_id: s.minorId, origin: "patient", revoked_at: null },
    ]);
  });
});

describe("lecturas de la cuenta (flujo del paciente)", () => {
  it("findPatientOfAccount solo devuelve pacientes de esa cuenta", async () => {
    const s = await scenario();
    const stranger = await createPatient(pool, { fullName: "Ajena" });
    expect((await findPatientOfAccount(pool, s.owner.accountId, s.owner.patientId))?.fullName).toBe("Titular Uno");
    expect((await findPatientOfAccount(pool, s.owner.accountId, s.minorId))?.fullName).toBe("Menor Uno");
    expect(await findPatientOfAccount(pool, s.owner.accountId, stranger.patientId)).toBeNull();
    expect(await findPatientOfAccount(pool, 9_999_999, s.owner.patientId)).toBeNull();
  });

  it("listAccountPatientIds devuelve titular y menores de la cuenta, ordenados", async () => {
    const s = await scenario();
    await createPatient(pool);
    expect(await listAccountPatientIds(pool, s.owner.accountId)).toEqual([s.owner.patientId, s.minorId]);
  });

  it("listAccountPatientIdsLinkedToDoctor solo trae los vinculados y activos con ESE médico", async () => {
    const s = await scenario();
    const other = await createDoctor(pool);
    const otherCtx = createTenantContext(other.doctorId, { kind: "doctor", userId: other.user.id });
    await linkPatientToDoctor(s.staff, pool, s.owner.patientId);
    await linkPatientToDoctor(otherCtx, pool, s.minorId);
    expect(await listAccountPatientIdsLinkedToDoctor(s.staff, pool, s.owner.accountId)).toEqual([s.owner.patientId]);
    expect(await listAccountPatientIdsLinkedToDoctor(otherCtx, pool, s.owner.accountId)).toEqual([s.minorId]);
    await revokeAccountLinks(s.staff, pool, s.owner.accountId, NOW);
    expect(await listAccountPatientIdsLinkedToDoctor(s.staff, pool, s.owner.accountId)).toEqual([]);
    expect(await listAccountPatientIdsLinkedToDoctor(otherCtx, pool, s.owner.accountId)).toEqual([s.minorId]);
  });
});
