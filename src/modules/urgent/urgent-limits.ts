import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { ConflictError, TooManyAttemptsError } from "../../http/errors.js";
import type { TenantContext } from "../../lib/tenant.js";

type Executor = Pick<Pool, "execute"> | Pick<PoolConnection, "execute">;

/** Protecciones contra el abuso de las urgencias (spec FR-025, FR-026 y FR-030). */
export const URGENT_LIMITS = {
  /** Solicitudes por cuenta (con cualquier consultorio) dentro de la ventana, contando las que terminaron sin espacio. */
  requestsPerWindow: 3,
  windowMs: 24 * 3_600_000,
  /** Una petición idéntica de la misma cuenta y paciente en este lapso es un doble envío, no una solicitud nueva. */
  doubleSubmitMs: 2 * 60_000,
} as const;

/**
 * La urgencia que la MISMA cuenta pidió para este paciente hace menos de 2 minutos y sigue vigente (doble envío del
 * formulario): se devuelve en lugar de crear otra, sin contar de nuevo. `null` si no hay.
 */
export async function findRecentOwnUrgent(
  ctx: TenantContext,
  executor: Executor,
  input: { userId: number; patientId: number; now: Date },
): Promise<{ id: number; startUtc: Date; endUtc: Date } | null> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT id, start_utc, end_utc FROM appointment
      WHERE doctor_id = ? AND patient_id = ? AND kind = 'urgent' AND status = 'booked'
        AND created_by_user_id = ? AND created_at >= ? AND start_utc > ?
      ORDER BY id DESC LIMIT 1`,
    [ctx.doctorId, input.patientId, input.userId, new Date(input.now.getTime() - URGENT_LIMITS.doubleSubmitMs), input.now],
  );
  const row = rows[0];
  return row ? { id: Number(row.id), startUtc: row.start_utc as Date, endUtc: row.end_utc as Date } : null;
}

/**
 * Lanza `ConflictError` `urgent_active` (409) si el paciente ya tiene una urgencia vigente que aún no empieza (con cualquier
 * consultorio) y `TooManyAttemptsError` (429) si la cuenta ya hizo 3 solicitudes en las últimas 24 horas. Se llama dentro de
 * `withCalendarLock`, así que las ráfagas hacia un mismo consultorio se serializan y el conteo es exacto.
 */
export async function assertWithinUrgentLimits(
  _ctx: TenantContext,
  executor: Executor,
  input: { userId: number; patientId: number; now: Date },
): Promise<void> {
  const [active] = await executor.execute<RowDataPacket[]>(
    "SELECT id FROM appointment WHERE patient_id = ? AND kind = 'urgent' AND status = 'booked' AND start_utc > ? LIMIT 1",
    [input.patientId, input.now],
  );
  if (active[0]) {
    throw new ConflictError("Ya tienes una urgencia vigente. Puedes cancelarla antes de pedir otra.", "urgent_active");
  }

  const since = new Date(input.now.getTime() - URGENT_LIMITS.windowMs);
  const [recent] = await executor.execute<RowDataPacket[]>(
    "SELECT COUNT(*) AS n, MIN(occurred_at) AS oldest FROM calendar_action_log WHERE actor_user_id = ? AND action = 'urgent_requested' AND occurred_at >= ?",
    [input.userId, since],
  );
  if (Number(recent[0]?.n ?? 0) >= URGENT_LIMITS.requestsPerWindow) {
    const oldest = recent[0]?.oldest;
    const wait = oldest instanceof Date ? oldest.getTime() + URGENT_LIMITS.windowMs - input.now.getTime() : URGENT_LIMITS.windowMs;
    throw new TooManyAttemptsError(Math.max(1000, wait));
  }
}
