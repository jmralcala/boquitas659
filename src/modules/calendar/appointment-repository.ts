import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import type { StaffContext, TenantContext } from "../../lib/tenant.js";
import { listPatientNamesForDoctor } from "../patients/patient-repository.js";

type Executor = Pick<Pool, "execute"> | Pick<PoolConnection, "execute">;

export interface AppointmentRecord {
  id: number;
  patientId: number;
  /** Nombre del paciente (único dato personal que muestra la agenda); el detalle está en la ruta auditada. */
  patientName: string;
  startUtc: Date;
  endUtc: Date;
  status: "booked" | "cancelled";
  createdByRole: "doctor" | "reception" | "patient";
  createdAt: Date;
  cancelledByRole: "doctor" | "reception" | "patient" | null;
  cancelledAt: Date | null;
}

const SELECT_APPOINTMENT = `SELECT a.id, a.patient_id, a.start_utc, a.end_utc, a.status, a.created_by_role, a.created_at,
       a.cancelled_by_role, a.cancelled_at
  FROM appointment a`;

/** Nombre que se muestra si, por una inconsistencia, el paciente no está vinculado con el médico (la cita nunca se oculta). */
const UNKNOWN_PATIENT = "Paciente";

function toRecord(row: RowDataPacket, names: ReadonlyMap<number, string>): AppointmentRecord {
  return {
    id: Number(row.id),
    patientId: Number(row.patient_id),
    // El nombre sale de patient-repository, SOLO si el paciente está vinculado con este médico (principio II).
    patientName: names.get(Number(row.patient_id)) ?? UNKNOWN_PATIENT,
    startUtc: row.start_utc as Date,
    endUtc: row.end_utc as Date,
    status: row.status === "cancelled" ? "cancelled" : "booked",
    createdByRole: row.created_by_role === "reception" ? "reception" : row.created_by_role === "patient" ? "patient" : "doctor",
    createdAt: row.created_at as Date,
    cancelledByRole:
      row.cancelled_by_role === null ? null : row.cancelled_by_role === "reception" ? "reception" : row.cancelled_by_role === "patient" ? "patient" : "doctor",
    cancelledAt: row.cancelled_at === null ? null : (row.cancelled_at as Date),
  };
}

/** Citas vigentes del médico que se solapan con el rango UTC [desde, hasta), ordenadas por inicio. */
export async function listBookedInRange(ctx: StaffContext, executor: Executor, fromUtc: Date, toUtc: Date): Promise<AppointmentRecord[]> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `${SELECT_APPOINTMENT}
      WHERE a.doctor_id = ? AND a.status = 'booked' AND a.start_utc < ? AND a.end_utc > ?
      ORDER BY a.start_utc, a.id`,
    [ctx.doctorId, toUtc, fromUtc],
  );
  const names = await listPatientNamesForDoctor(ctx, executor, rows.map((row) => Number(row.patient_id)));
  return rows.map((row) => toRecord(row, names));
}

/**
 * Espacios ocupados por citas vigentes en [desde, hasta): SOLO identificador e intervalo, nunca datos de pacientes.
 * Es lo único que ve el calendario público del paciente (acepta cualquier contexto, también el de paciente).
 */
export async function listBookedSpansInRange(
  ctx: TenantContext,
  executor: Executor,
  fromUtc: Date,
  toUtc: Date,
): Promise<{ id: number; startUtc: Date; endUtc: Date }[]> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT id, start_utc, end_utc FROM appointment
      WHERE doctor_id = ? AND status = 'booked' AND start_utc < ? AND end_utc > ?
      ORDER BY start_utc, id`,
    [ctx.doctorId, toUtc, fromUtc],
  );
  return rows.map((row) => ({ id: Number(row.id), startUtc: row.start_utc as Date, endUtc: row.end_utc as Date }));
}

/** Una cita del médico (vigente o cancelada); `null` si no existe o es de otro médico. */
export async function findAppointment(ctx: StaffContext, executor: Executor, id: number): Promise<AppointmentRecord | null> {
  const [rows] = await executor.execute<RowDataPacket[]>(`${SELECT_APPOINTMENT} WHERE a.doctor_id = ? AND a.id = ?`, [ctx.doctorId, id]);
  const row = rows[0];
  if (!row) return null;
  return toRecord(row, await listPatientNamesForDoctor(ctx, executor, [Number(row.patient_id)]));
}

// --- Escrituras: SIEMPRE dentro de `withCalendarLock` (la conexión es la de esa transacción) ----------------------------

/** Cita vigente que se solapa con [inicio, fin) (cualquiera, aunque empiece a otra hora); `null` si no hay. */
export async function findOverlappingBooked(
  ctx: TenantContext,
  connection: Executor,
  startUtc: Date,
  endUtc: Date,
): Promise<{ id: number } | null> {
  const [rows] = await connection.execute<RowDataPacket[]>(
    "SELECT id FROM appointment WHERE doctor_id = ? AND status = 'booked' AND start_utc < ? AND end_utc > ? LIMIT 1",
    [ctx.doctorId, endUtc, startUtc],
  );
  return rows[0] ? { id: Number(rows[0].id) } : null;
}

/** Inserta una cita vigente a nombre de quien actúa (usuario y rol salen del contexto). */
export async function insertAppointment(
  ctx: TenantContext,
  connection: Executor,
  input: { patientId: number; startUtc: Date; endUtc: Date; now: Date },
): Promise<number> {
  const [result] = await connection.execute<import("mysql2/promise").ResultSetHeader>(
    `INSERT INTO appointment (doctor_id, patient_id, start_utc, end_utc, status, kind, created_by_user_id, created_by_role, created_at)
     VALUES (?, ?, ?, ?, 'booked', 'regular', ?, ?, ?)`,
    [ctx.doctorId, input.patientId, input.startUtc, input.endUtc, ctx.actor.userId, ctx.actor.kind, input.now],
  );
  return result.insertId;
}

/**
 * Cancela una cita vigente del médico cuyo fin aún no llega. Devuelve `false` si no cambió ninguna fila (ya cancelada,
 * ya terminada o de otro médico). Se usa dentro de `withCalendarLock`.
 */
export async function cancelBookedAppointment(ctx: TenantContext, connection: Executor, id: number, now: Date): Promise<boolean> {
  const [result] = await connection.execute<import("mysql2/promise").ResultSetHeader>(
    `UPDATE appointment
        SET status = 'cancelled', cancelled_by_user_id = ?, cancelled_by_role = ?, cancelled_at = ?
      WHERE id = ? AND doctor_id = ? AND status = 'booked' AND end_utc > ?`,
    [ctx.actor.userId, ctx.actor.kind, now, id, ctx.doctorId, now],
  );
  return result.affectedRows === 1;
}
