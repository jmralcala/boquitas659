import type { Pool, PoolConnection } from "mysql2/promise";

type Executor = Pick<Pool, "execute"> | Pick<PoolConnection, "execute">;

/** Meta del piloto: reservar en menos de 2 minutos. */
export const BOOKING_TARGET_SECONDS = 120;

const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

/**
 * Cuenta que un paciente entró a la pantalla de reservar de un consultorio. Contador diario agregado por médico:
 * no guarda quién ni desde dónde (principio I). Incremento atómico.
 */
export async function recordBookingStarted(executor: Executor, doctorId: number, now: Date): Promise<void> {
  await executor.execute(
    "INSERT INTO pilot_metric_daily (day, doctor_id, started) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE started = started + 1",
    [utcDay(now), doctorId],
  );
}

/**
 * Cuenta una reserva completada y, si se conoce, cuánto tardó el paciente (segundos desde que entró a la pantalla).
 * Una duración nula (firma inválida, vencida o ausente) cuenta la reserva pero no entra en el tiempo.
 */
export async function recordBookingCompleted(executor: Executor, doctorId: number, now: Date, durationSeconds: number | null): Promise<void> {
  const seconds = durationSeconds === null ? null : Math.max(0, Math.round(durationSeconds));
  await executor.execute(
    `INSERT INTO pilot_metric_daily (day, doctor_id, completed, duration_sum_seconds, duration_count, under_target_count)
     VALUES (?, ?, 1, ?, ?, ?)
     ON DUPLICATE KEY UPDATE completed = completed + 1,
                             duration_sum_seconds = duration_sum_seconds + VALUES(duration_sum_seconds),
                             duration_count = duration_count + VALUES(duration_count),
                             under_target_count = under_target_count + VALUES(under_target_count)`,
    [utcDay(now), doctorId, seconds ?? 0, seconds === null ? 0 : 1, seconds !== null && seconds < BOOKING_TARGET_SECONDS ? 1 : 0],
  );
}
