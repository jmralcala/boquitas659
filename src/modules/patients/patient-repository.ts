import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { TenantContext } from "../../lib/tenant.js";

type Executor = Pick<Pool, "execute"> | Pick<PoolConnection, "execute">;

export interface PatientRecord {
  id: number;
  accountId: number;
  fullName: string;
  /** Fecha de nacimiento como texto AAAA-MM-DD (nunca la edad). */
  birthDate: string;
  email: string | null;
  phone: string | null;
  isMinorDependent: boolean;
  createdAt: Date;
}

// birth_date se lee como texto para evitar desfases de zona horaria al convertir DATE a Date.
const COLUMNS = `p.id, p.account_id, p.full_name, DATE_FORMAT(p.birth_date, '%Y-%m-%d') AS birth_date, p.email, p.phone,
       p.is_minor_dependent, p.created_at`;

function toPatient(row: RowDataPacket): PatientRecord {
  return {
    id: Number(row.id),
    accountId: Number(row.account_id),
    fullName: String(row.full_name),
    birthDate: String(row.birth_date),
    email: row.email === null ? null : String(row.email),
    phone: row.phone === null ? null : String(row.phone),
    isMinorDependent: row.is_minor_dependent === 1,
    createdAt: row.created_at as Date,
  };
}

// --- Cuenta del paciente (alcance: la propia cuenta, no un médico) -------------------------------------------

export async function insertAccount(executor: Executor, input: { userId: number; phone: string }): Promise<number> {
  const [result] = await executor.execute<ResultSetHeader>("INSERT INTO patient_account (user_id, phone) VALUES (?, ?)", [
    input.userId,
    input.phone,
  ]);
  return result.insertId;
}

export async function findAccountByUserId(executor: Executor, userId: number): Promise<{ id: number; phone: string } | null> {
  const [rows] = await executor.execute<RowDataPacket[]>("SELECT id, phone FROM patient_account WHERE user_id = ?", [userId]);
  return rows[0] ? { id: Number(rows[0].id), phone: String(rows[0].phone) } : null;
}

export async function insertPatient(
  executor: Executor,
  input: {
    accountId: number;
    fullName: string;
    birthDate: string;
    email: string | null;
    phone: string | null;
    isMinorDependent: boolean;
  },
): Promise<number> {
  const [result] = await executor.execute<ResultSetHeader>(
    "INSERT INTO patient (account_id, full_name, birth_date, email, phone, is_minor_dependent) VALUES (?, ?, ?, ?, ?, ?)",
    [input.accountId, input.fullName, input.birthDate, input.email, input.phone, input.isMinorDependent ? 1 : 0],
  );
  return result.insertId;
}

/** Pacientes de una cuenta (el propio y los adicionales). El alcance es la cuenta del tutor, no un médico. */
export async function listPatientsByAccount(executor: Executor, accountId: number): Promise<PatientRecord[]> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT ${COLUMNS} FROM patient p WHERE p.account_id = ? ORDER BY p.is_minor_dependent ASC, p.id ASC`,
    [accountId],
  );
  return rows.map(toPatient);
}

// --- Lecturas por médico: SIEMPRE reciben el contexto de médico y filtran por él (principio II) -------------

export async function listPatientsForDoctor(ctx: TenantContext, executor: Executor): Promise<PatientRecord[]> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT ${COLUMNS}
       FROM patient p JOIN doctor_patient dp ON dp.patient_id = p.id
      WHERE dp.doctor_id = ?
      ORDER BY p.full_name ASC, p.id ASC`,
    [ctx.doctorId],
  );
  return rows.map(toPatient);
}

/** Devuelve `null` tanto si el paciente no existe como si no pertenece a este médico (no se distingue). */
export async function findPatientForDoctor(
  ctx: TenantContext,
  executor: Executor,
  patientId: number,
): Promise<PatientRecord | null> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT ${COLUMNS}
       FROM patient p JOIN doctor_patient dp ON dp.patient_id = p.id
      WHERE dp.doctor_id = ? AND p.id = ?`,
    [ctx.doctorId, patientId],
  );
  return rows[0] ? toPatient(rows[0]) : null;
}
