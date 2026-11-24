import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { StaffContext, TenantContext } from "../../lib/tenant.js";

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

export async function listPatientsForDoctor(ctx: StaffContext, executor: Executor): Promise<PatientRecord[]> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT ${COLUMNS}
       FROM patient p JOIN doctor_patient dp ON dp.patient_id = p.id
      WHERE dp.doctor_id = ? AND dp.revoked_at IS NULL
      ORDER BY p.full_name ASC, p.id ASC
      LIMIT 500`,
    [ctx.doctorId],
  );
  return rows.map(toPatient);
}

/** Devuelve `null` tanto si el paciente no existe como si no pertenece a este médico (no se distingue). */
export async function findPatientForDoctor(
  ctx: StaffContext,
  executor: Executor,
  patientId: number,
): Promise<PatientRecord | null> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT ${COLUMNS}
       FROM patient p JOIN doctor_patient dp ON dp.patient_id = p.id
      WHERE dp.doctor_id = ? AND p.id = ? AND dp.revoked_at IS NULL`,
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
export async function findTutorForMinor(ctx: StaffContext, executor: Executor, minorPatientId: number): Promise<TutorRecord | null> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT t.full_name, t.phone, t.email
       FROM patient p
       JOIN doctor_patient dp ON dp.patient_id = p.id AND dp.doctor_id = ? AND dp.revoked_at IS NULL
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
 * agenda para mostrar el nombre junto a cada cita sin leer nada más del paciente. Incluye los vínculos REVOCADOS: el
 * consultorio conserva el nombre en las citas pasadas, pero ya no ve el contacto.
 */
export async function listPatientNamesForDoctor(
  ctx: StaffContext,
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
       JOIN doctor_patient dp ON dp.patient_id = p.id AND dp.doctor_id = ? AND dp.revoked_at IS NULL
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

// --- Lecturas de la cuenta del paciente (flujo del paciente) y revocación ---------------------------------------------
// Toda lectura de la tabla patient vive en este archivo (lo audita route-audit.test.ts).

/** El paciente `patientId` solo si pertenece a esa cuenta (titular o paciente adicional); `null` si es de otra. */
export async function findPatientOfAccount(executor: Executor, accountId: number, patientId: number): Promise<PatientRecord | null> {
  const [rows] = await executor.execute<RowDataPacket[]>(`SELECT ${COLUMNS} FROM patient p WHERE p.account_id = ? AND p.id = ?`, [accountId, patientId]);
  return rows[0] ? toPatient(rows[0]) : null;
}

/** Ids de todos los pacientes de la cuenta (titular primero, luego los adicionales). */
export async function listAccountPatientIds(executor: Executor, accountId: number): Promise<number[]> {
  const [rows] = await executor.execute<RowDataPacket[]>("SELECT p.id FROM patient p WHERE p.account_id = ? ORDER BY p.is_minor_dependent ASC, p.id ASC", [accountId]);
  return rows.map((row) => Number(row.id));
}

/** Ids de los pacientes de la cuenta con vínculo ACTIVO (no revocado) con el médico del contexto. */
export async function listAccountPatientIdsLinkedToDoctor(ctx: TenantContext, executor: Executor, accountId: number): Promise<number[]> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT p.id FROM patient p JOIN doctor_patient dp ON dp.patient_id = p.id
      WHERE p.account_id = ? AND dp.doctor_id = ? AND dp.revoked_at IS NULL
      ORDER BY p.is_minor_dependent ASC, p.id ASC`,
    [accountId, ctx.doctorId],
  );
  return rows.map((row) => Number(row.id));
}

/** ¿Algún paciente de la cuenta de `patientId` tiene un vínculo REVOCADO con el médico del contexto? */
export async function accountHasRevokedLink(ctx: TenantContext, executor: Executor, patientId: number): Promise<boolean> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT 1 FROM patient p0
       JOIN patient p ON p.account_id = p0.account_id
       JOIN doctor_patient dp ON dp.patient_id = p.id
      WHERE p0.id = ? AND dp.doctor_id = ? AND dp.revoked_at IS NOT NULL
      LIMIT 1`,
    [patientId, ctx.doctorId],
  );
  return rows.length > 0;
}

/**
 * Revoca todos los vínculos activos de la cuenta con el médico del contexto (titular y pacientes adicionales). Devuelve
 * cuántos vínculos cambió. Debe llamarse dentro de `withCalendarLock`.
 */
export async function revokeAccountLinks(ctx: TenantContext, executor: Executor, accountId: number, now: Date): Promise<number> {
  const [result] = await executor.execute<ResultSetHeader>(
    `UPDATE doctor_patient dp JOIN patient p ON p.id = dp.patient_id
        SET dp.revoked_at = ?
      WHERE p.account_id = ? AND dp.doctor_id = ? AND dp.revoked_at IS NULL`,
    [now, accountId, ctx.doctorId],
  );
  return result.affectedRows;
}

/**
 * Reactiva los vínculos revocados de la cuenta de `patientId` con el médico del contexto (el propio paciente vuelve a
 * reservar). Conserva las filas e historial; el origen pasa a `patient`.
 */
export async function reactivateAccountLinks(ctx: TenantContext, executor: Executor, patientId: number, userId: number | null): Promise<void> {
  await executor.execute(
    `UPDATE doctor_patient dp
       JOIN patient p ON p.id = dp.patient_id
       JOIN patient p0 ON p0.account_id = p.account_id
        SET dp.revoked_at = NULL, dp.origin = 'patient', dp.created_by_user_id = ?
      WHERE p0.id = ? AND dp.doctor_id = ? AND dp.revoked_at IS NOT NULL`,
    [userId, patientId, ctx.doctorId],
  );
}

/** Correo de la cuenta de paciente (el del titular o tutor) a partir del usuario con sesión. */
export async function findAccountEmail(executor: Executor, userId: number): Promise<string | null> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    "SELECT u.email FROM patient_account pa JOIN `user` u ON u.id = pa.user_id WHERE pa.user_id = ?",
    [userId],
  );
  return rows[0] ? String(rows[0].email) : null;
}

/**
 * Correo de la cuenta a la que se avisa de una cita (el del tutor, si el paciente es un menor), solo si el vínculo del
 * paciente con el consultorio de la cita sigue activo. Es para tareas del sistema (recordatorios) que corren sin
 * contexto de médico: el id de la cita sale de la propia base de datos, nunca de una petición.
 */
export async function findNotificationEmailForAppointment(executor: Executor, appointmentId: number): Promise<string | null> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT u.email
       FROM appointment a
       JOIN doctor_patient dp ON dp.doctor_id = a.doctor_id AND dp.patient_id = a.patient_id AND dp.revoked_at IS NULL
       JOIN patient p ON p.id = a.patient_id
       JOIN patient_account pa ON pa.id = p.account_id
       JOIN \`user\` u ON u.id = pa.user_id
      WHERE a.id = ?`,
    [appointmentId],
  );
  return rows[0] ? String(rows[0].email) : null;
}

/** Consultorio con el que la cuenta tiene al menos un vínculo ACTIVO (no revocado). */
export interface ActiveOffice {
  doctorId: number;
  doctorName: string;
  /** Quién creó el primer vínculo: el propio paciente al reservar, o el consultorio al agendarle. */
  origin: "patient" | "office";
  linkedAt: Date;
}

/** Consultorios con vínculo activo con alguna persona de la cuenta, ordenados por nombre. */
export async function listActiveOffices(executor: Executor, accountId: number): Promise<ActiveOffice[]> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT dp.doctor_id, d.full_name, MIN(dp.created_at) AS linked_at,
            SUBSTRING_INDEX(GROUP_CONCAT(dp.origin ORDER BY dp.created_at, dp.id), ',', 1) AS origin
       FROM doctor_patient dp
       JOIN patient p ON p.id = dp.patient_id
       JOIN doctor d ON d.id = dp.doctor_id
      WHERE p.account_id = ? AND dp.revoked_at IS NULL
      GROUP BY dp.doctor_id, d.full_name
      ORDER BY d.full_name, dp.doctor_id`,
    [accountId],
  );
  return rows.map((row) => ({
    doctorId: Number(row.doctor_id),
    doctorName: String(row.full_name),
    origin: row.origin === "patient" ? "patient" : "office",
    linkedAt: row.linked_at as Date,
  }));
}

/** Instante de la revocación más reciente de un vínculo de la cuenta con el médico del contexto; `null` si no hay ninguna. */
export async function latestLinkRevocation(ctx: TenantContext, executor: Executor, accountId: number): Promise<Date | null> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT MAX(dp.revoked_at) AS last_revoked
       FROM doctor_patient dp JOIN patient p ON p.id = dp.patient_id
      WHERE p.account_id = ? AND dp.doctor_id = ? AND dp.revoked_at IS NOT NULL`,
    [accountId, ctx.doctorId],
  );
  const value = rows[0]?.last_revoked;
  return value instanceof Date ? value : null;
}
