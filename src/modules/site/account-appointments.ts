import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";

type Executor = Pick<Pool, "execute"> | Pick<PoolConnection, "execute">;

// Lecturas de citas POR CUENTA de paciente (no por médico): los ids de pacientes salen SIEMPRE de `listAccountPatientIds`
// de la cuenta de quien tiene la sesión. Nunca devuelven datos de otros pacientes del consultorio.

/** Cita de las personas de una cuenta de paciente, con lo que el paciente ve del consultorio. */
export interface PatientAppointmentRow {
  id: number;
  doctorId: number;
  patientId: number;
  startUtc: Date;
  endUtc: Date;
  status: "booked" | "cancelled";
  doctorName: string;
  officePhone: string | null;
  address: string | null;
  timezone: string;
  cancelNoticeHours: number;
}

const SELECT_FOR_PATIENT = `SELECT a.id, a.doctor_id, a.patient_id, a.start_utc, a.end_utc, a.status,
       d.full_name AS doctor_name, d.office_phone, ds.address,
       COALESCE(cs.timezone, 'America/Mexico_City') AS timezone, COALESCE(cs.cancel_notice_hours, 24) AS cancel_notice_hours
  FROM appointment a
  JOIN doctor d ON d.id = a.doctor_id
  LEFT JOIN doctor_site ds ON ds.doctor_id = a.doctor_id
  LEFT JOIN calendar_settings cs ON cs.doctor_id = a.doctor_id`;

function toPatientRow(row: RowDataPacket): PatientAppointmentRow {
  return {
    id: Number(row.id),
    doctorId: Number(row.doctor_id),
    patientId: Number(row.patient_id),
    startUtc: row.start_utc as Date,
    endUtc: row.end_utc as Date,
    status: row.status === "cancelled" ? "cancelled" : "booked",
    doctorName: String(row.doctor_name),
    officePhone: row.office_phone !== null && /^\d{10}$/.test(String(row.office_phone)) ? String(row.office_phone) : null,
    address: row.address === null ? null : String(row.address),
    timezone: String(row.timezone),
    cancelNoticeHours: Number(row.cancel_notice_hours),
  };
}

/**
 * Citas de los pacientes indicados (los ids salen SIEMPRE de `listAccountPatientIds` de la cuenta de quien tiene la
 * sesión) cuyo inicio es posterior a `sinceUtc`, con cualquier consultorio.
 */
export async function listAppointmentsForPatients(executor: Executor, patientIds: readonly number[], sinceUtc: Date): Promise<PatientAppointmentRow[]> {
  if (patientIds.length === 0) return [];
  const marks = patientIds.map(() => "?").join(", ");
  const [rows] = await executor.execute<RowDataPacket[]>(
    `${SELECT_FOR_PATIENT} WHERE a.patient_id IN (${marks}) AND a.start_utc >= ? ORDER BY a.start_utc, a.id`,
    [...patientIds, sinceUtc],
  );
  return rows.map(toPatientRow);
}

/** Una cita de uno de los pacientes indicados; `null` si no existe o es de otra cuenta. */
export async function findAppointmentForPatients(executor: Executor, patientIds: readonly number[], id: number): Promise<PatientAppointmentRow | null> {
  if (patientIds.length === 0) return null;
  const marks = patientIds.map(() => "?").join(", ");
  const [rows] = await executor.execute<RowDataPacket[]>(`${SELECT_FOR_PATIENT} WHERE a.id = ? AND a.patient_id IN (${marks})`, [id, ...patientIds]);
  return rows[0] ? toPatientRow(rows[0]) : null;
}

/** Cancelaciones hechas por un paciente (usuario) desde `since`: cuántas y cuándo fue la más antigua. */
export async function countPatientCancellations(executor: Executor, userId: number, since: Date): Promise<{ count: number; oldest: Date | null }> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    "SELECT COUNT(*) AS n, MIN(cancelled_at) AS oldest FROM appointment WHERE cancelled_by_user_id = ? AND cancelled_by_role = 'patient' AND cancelled_at >= ?",
    [userId, since],
  );
  return { count: Number(rows[0]?.n ?? 0), oldest: rows[0]?.oldest instanceof Date ? rows[0].oldest : null };
}
