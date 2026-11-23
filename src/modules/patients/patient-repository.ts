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
      ORDER BY p.full_name ASC, p.id ASC
      LIMIT 500`,
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

export interface TutorRecord {
  fullName: string;
  phone: string | null;
  email: string | null;
}

/**
 * Tutor de un menor, SOLO si el menor está vinculado con este médico. El tutor no necesita estar vinculado por su
 * cuenta: se llega a él a través del menor, que es la relación que autoriza al médico a verlo.
 */
export async function findTutorForMinor(ctx: TenantContext, executor: Executor, minorPatientId: number): Promise<TutorRecord | null> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT t.full_name, t.phone, t.email
       FROM patient p
       JOIN doctor_patient dp ON dp.patient_id = p.id AND dp.doctor_id = ?
       JOIN patient t ON t.account_id = p.account_id AND t.is_minor_dependent = 0
      WHERE p.id = ? AND p.is_minor_dependent = 1
      ORDER BY t.id ASC LIMIT 1`,
    [ctx.doctorId, minorPatientId],
  );
  const row = rows[0];
  return row
    ? {
        fullName: String(row.full_name),
        phone: row.phone === null ? null : String(row.phone),
        email: row.email === null ? null : String(row.email),
      }
    : null;
}

/**
 * Nombres de pacientes por id, SOLO de los vinculados con este médico (los demás no aparecen en el resultado). Lo usa la
 * agenda para mostrar el nombre junto a cada cita sin leer nada más del paciente.
 */
export async function listPatientNamesForDoctor(
  ctx: TenantContext,
  executor: Executor,
  patientIds: readonly number[],
): Promise<Map<number, string>> {
  const ids = [...new Set(patientIds)];
  const names = new Map<number, string>();
  // Se consulta por tandas para no armar una lista de parámetros enorme.
  for (let offset = 0; offset < ids.length; offset += 500) {
    const chunk = ids.slice(offset, offset + 500);
    const placeholders = chunk.map(() => "?").join(", ");
    const [rows] = await executor.execute<RowDataPacket[]>(
      `SELECT p.id, p.full_name
         FROM patient p JOIN doctor_patient dp ON dp.patient_id = p.id
        WHERE dp.doctor_id = ? AND p.id IN (${placeholders})`,
      [ctx.doctorId, ...chunk],
    );
    for (const row of rows) names.set(Number(row.id), String(row.full_name));
  }
  return names;
}

/**
 * Correo de la cuenta del paciente (el del tutor, si el paciente es un menor), solo si el paciente está vinculado con
 * este médico. `null` si no hay nadie a quien avisar.
 */
export async function findNotificationEmailForDoctor(ctx: TenantContext, executor: Executor, patientId: number): Promise<string | null> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT u.email
       FROM patient p
       JOIN doctor_patient dp ON dp.patient_id = p.id AND dp.doctor_id = ?
       JOIN patient_account pa ON pa.id = p.account_id
       JOIN \`user\` u ON u.id = pa.user_id
      WHERE p.id = ?`,
    [ctx.doctorId, patientId],
  );
  return rows[0] ? String(rows[0].email) : null;
}

/**
 * Nombre de un paciente para un aviso del sistema. El outbox procesa los correos sin contexto de médico: el id viene
 * del `payload` que se guardó dentro de una transacción ya validada contra el médico. No uses esta función en rutas.
 */
export async function findPatientNameForNotice(executor: Executor, patientId: number): Promise<string | null> {
  const [rows] = await executor.execute<RowDataPacket[]>("SELECT p.full_name FROM patient p WHERE p.id = ?", [patientId]);
  return rows[0] ? String(rows[0].full_name) : null;
}
