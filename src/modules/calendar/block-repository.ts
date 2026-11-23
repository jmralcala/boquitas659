import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import type { TenantContext } from "../../lib/tenant.js";
import { listPatientNamesForDoctor } from "../patients/patient-repository.js";

type Executor = Pick<Pool, "execute"> | Pick<PoolConnection, "execute">;

export interface BlockRecord {
  id: number;
  startUtc: Date;
  endUtc: Date;
  /** Motivo opcional, privado del consultorio (no se muestra a pacientes). */
  reason: string | null;
  createdByRole: "doctor" | "reception";
}

function toRecord(row: RowDataPacket): BlockRecord {
  return {
    id: Number(row.id),
    startUtc: row.start_utc as Date,
    endUtc: row.end_utc as Date,
    reason: row.reason === null ? null : String(row.reason),
    createdByRole: row.created_by_role === "reception" ? "reception" : "doctor",
  };
}

/** Bloqueos del médico que se solapan con el rango UTC [desde, hasta), ordenados por inicio. */
export async function listBlocksInRange(ctx: TenantContext, executor: Executor, fromUtc: Date, toUtc: Date): Promise<BlockRecord[]> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT id, start_utc, end_utc, reason, created_by_role FROM calendar_block
      WHERE doctor_id = ? AND start_utc < ? AND end_utc > ?
      ORDER BY start_utc, id`,
    [ctx.doctorId, toUtc, fromUtc],
  );
  return rows.map(toRecord);
}

/** Bloqueos vigentes o futuros (su fin es posterior a `now`), ordenados por inicio. */
export async function listUpcomingBlocks(ctx: TenantContext, executor: Executor, now: Date): Promise<BlockRecord[]> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT id, start_utc, end_utc, reason, created_by_role FROM calendar_block
      WHERE doctor_id = ? AND end_utc > ?
      ORDER BY start_utc, id
      LIMIT 200`,
    [ctx.doctorId, now],
  );
  return rows.map(toRecord);
}

/** ¿Algún bloqueo del médico se solapa con [inicio, fin)? Se usa dentro de `withCalendarLock`. */
export async function hasOverlappingBlock(ctx: TenantContext, connection: Executor, startUtc: Date, endUtc: Date): Promise<boolean> {
  const [rows] = await connection.execute<RowDataPacket[]>(
    "SELECT id FROM calendar_block WHERE doctor_id = ? AND start_utc < ? AND end_utc > ? LIMIT 1",
    [ctx.doctorId, endUtc, startUtc],
  );
  return rows.length > 0;
}

/** Cita vigente que impide bloquear un rango: lo mínimo para mostrársela a quien intenta bloquear. */
export interface ConflictingAppointment {
  id: number;
  startUtc: Date;
  endUtc: Date;
  patientName: string;
}

export const MAX_LISTED_CONFLICTS = 50;

/**
 * Citas que impiden bloquear [inicio, fin): vigentes que se solapan con el rango Y cuyo fin aún no llega (una cita
 * ya pasada no cuenta). Devuelve hasta 50 (por inicio) y el total. Se usa dentro de `withCalendarLock`.
 */
export async function findConflictingAppointments(
  ctx: TenantContext,
  connection: Executor,
  fromUtc: Date,
  toUtc: Date,
  now: Date,
): Promise<{ appointments: ConflictingAppointment[]; total: number }> {
  const where = "a.doctor_id = ? AND a.status = 'booked' AND a.start_utc < ? AND a.end_utc > ? AND a.end_utc > ?";
  const params = [ctx.doctorId, toUtc, fromUtc, now];
  const [rows] = await connection.execute<RowDataPacket[]>(
    `SELECT a.id, a.patient_id, a.start_utc, a.end_utc
       FROM appointment a
      WHERE ${where}
      ORDER BY a.start_utc, a.id
      LIMIT ${MAX_LISTED_CONFLICTS}`,
    params,
  );
  const [count] = await connection.execute<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM appointment a WHERE ${where}`, params);
  const names = await listPatientNamesForDoctor(ctx, connection, rows.map((row) => Number(row.patient_id)));
  return {
    appointments: rows.map((row) => ({
      id: Number(row.id),
      startUtc: row.start_utc as Date,
      endUtc: row.end_utc as Date,
      patientName: names.get(Number(row.patient_id)) ?? "Paciente",
    })),
    total: Number(count[0]?.n ?? 0),
  };
}

export async function insertBlock(
  ctx: TenantContext,
  connection: Executor,
  input: { startUtc: Date; endUtc: Date; reason: string | null; now: Date },
): Promise<number> {
  const [result] = await connection.execute<import("mysql2/promise").ResultSetHeader>(
    `INSERT INTO calendar_block (doctor_id, start_utc, end_utc, reason, created_by_user_id, created_by_role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [ctx.doctorId, input.startUtc, input.endUtc, input.reason, ctx.actor.userId, ctx.actor.kind, input.now],
  );
  return result.insertId;
}

/** Borra un bloqueo del médico; `false` si no existe o es de otro médico. */
export async function deleteBlock(ctx: TenantContext, connection: Executor, id: number): Promise<boolean> {
  const [result] = await connection.execute<import("mysql2/promise").ResultSetHeader>(
    "DELETE FROM calendar_block WHERE id = ? AND doctor_id = ?",
    [id, ctx.doctorId],
  );
  return result.affectedRows === 1;
}
