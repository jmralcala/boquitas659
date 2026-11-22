import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { logPatientAccess } from "../../src/modules/audit/access-log.js";
import { clearTables, createDoctor, createPatient, createTestPool, resetDatabase } from "./helpers/db.js";

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

async function count(): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM patient_access_log");
  return Number(rows[0]?.n);
}

describe("patient_access_log (solo anexar)", () => {
  it("registra quién, en nombre de qué médico, a qué paciente, con qué resultado y cuándo", async () => {
    const doctor = await createDoctor(pool);
    const patient = await createPatient(pool);
    const at = new Date("2026-06-01T10:00:00.000Z");
    await logPatientAccess(pool, { actorUserId: doctor.user.id, actorRole: "doctor", doctorId: doctor.doctorId, patientId: patient.patientId, outcome: "allowed", at });

    const [row] = await (async () => {
      const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM patient_access_log");
      return rows;
    })();
    expect(row).toMatchObject({
      actor_user_id: doctor.user.id,
      actor_role: "doctor",
      doctor_id: doctor.doctorId,
      patient_id: patient.patientId,
      outcome: "allowed",
    });
    expect((row?.occurred_at as Date).toISOString()).toBe("2026-06-01T10:00:00.000Z");
  });

  it("acepta intentos denegados sobre pacientes inexistentes (sin clave foránea al paciente)", async () => {
    const doctor = await createDoctor(pool);
    await logPatientAccess(pool, { actorUserId: doctor.user.id, actorRole: "doctor", doctorId: doctor.doctorId, patientId: 424242, outcome: "denied", at: new Date() });
    expect(await count()).toBe(1);
  });

  it("UPDATE y DELETE fallan por el disparador de solo anexar", async () => {
    const doctor = await createDoctor(pool);
    await logPatientAccess(pool, { actorUserId: doctor.user.id, actorRole: "doctor", doctorId: doctor.doctorId, patientId: 1, outcome: "allowed", at: new Date() });

    await expect(pool.execute("UPDATE patient_access_log SET outcome = 'denied'")).rejects.toThrow(/solo anexar/);
    await expect(pool.execute("UPDATE patient_access_log SET patient_id = 2")).rejects.toThrow(/solo anexar/);
    await expect(pool.execute("DELETE FROM patient_access_log")).rejects.toThrow(/solo anexar/);
    expect(await count()).toBe(1);
  });

  it("rechaza resultados y roles fuera de la lista cerrada", async () => {
    const doctor = await createDoctor(pool);
    await expect(
      pool.execute(
        "INSERT INTO patient_access_log (actor_user_id, actor_role, doctor_id, patient_id, outcome, occurred_at) VALUES (?, 'doctor', ?, 1, 'otro', UTC_TIMESTAMP(3))",
        [doctor.user.id, doctor.doctorId],
      ),
    ).rejects.toThrow();
    await expect(
      pool.execute(
        "INSERT INTO patient_access_log (actor_user_id, actor_role, doctor_id, patient_id, outcome, occurred_at) VALUES (?, 'patient', ?, 1, 'allowed', UTC_TIMESTAMP(3))",
        [doctor.user.id, doctor.doctorId],
      ),
    ).rejects.toThrow();
  });

  it("también son de solo anexar las aceptaciones de consentimiento (comprobación conjunta)", async () => {
    const doctor = await createDoctor(pool);
    const legal = await pool.execute("INSERT INTO legal_document (type, version, title, body, is_provisional, published_at) VALUES ('patient_privacy', 1, 't', 'b', 0, UTC_TIMESTAMP(3))");
    const documentId = (legal[0] as { insertId: number }).insertId;
    await pool.execute("INSERT INTO consent_acceptance (user_id, legal_document_id, accepted_at) VALUES (?, ?, UTC_TIMESTAMP(3))", [doctor.user.id, documentId]);
    await expect(pool.execute("DELETE FROM consent_acceptance WHERE legal_document_id = ?", [documentId])).rejects.toThrow(/solo anexar/);
  });
});
