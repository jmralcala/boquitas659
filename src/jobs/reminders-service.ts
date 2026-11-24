import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { Db } from "../db/pool.js";
import { withTransaction } from "../db/tx.js";
import type { Clock } from "../lib/clock.js";
import { isReminderDue } from "../lib/reminder-time.js";
import { enqueueEmail } from "../mail/outbox.js";
import { findNotificationEmailForAppointment } from "../modules/patients/patient-repository.js";

/** Citas que se procesan por ejecución del job. */
export const REMINDER_BATCH_SIZE = 200;

/** Horas por defecto del límite de cancelación si el médico no guardó su configuración. */
const DEFAULT_CANCEL_NOTICE_HOURS = 24;

/**
 * Encola el recordatorio de las citas que ya llegaron a su momento (inicio − (límite de cancelación + 6 h)), UNA sola vez
 * por cita aunque el job corra varias veces o dos procesos coincidan: el aviso solo se encola si esta transacción logra
 * la actualización condicional `reminder_enqueued_at IS NULL`. No se recuerda una cita cancelada, ya iniciada o reservada
 * después del momento del recordatorio (la confirmación ya cumple su función). Devuelve cuántos recordatorios encoló.
 */
export async function enqueueDueReminders(db: Db, clock: Clock, batchSize = REMINDER_BATCH_SIZE): Promise<number> {
  const now = clock.now();
  const limit = Math.max(1, Math.floor(batchSize));
  const [candidates] = await db.execute<RowDataPacket[]>(
    `SELECT a.id, a.start_utc, a.created_at, COALESCE(cs.cancel_notice_hours, ?) AS cancel_notice_hours
       FROM appointment a
       LEFT JOIN calendar_settings cs ON cs.doctor_id = a.doctor_id
      WHERE a.status = 'booked' AND a.kind = 'regular' AND a.reminder_enqueued_at IS NULL AND a.start_utc > ?
        AND DATE_SUB(a.start_utc, INTERVAL (COALESCE(cs.cancel_notice_hours, ?) + 6) HOUR) <= ?
        AND a.created_at <= DATE_SUB(a.start_utc, INTERVAL (COALESCE(cs.cancel_notice_hours, ?) + 6) HOUR)
      ORDER BY a.start_utc, a.id
      LIMIT ${limit}`,
    [DEFAULT_CANCEL_NOTICE_HOURS, now, DEFAULT_CANCEL_NOTICE_HOURS, now, DEFAULT_CANCEL_NOTICE_HOURS],
  );

  let enqueued = 0;
  for (const row of candidates) {
    // La misma regla en código: si la consulta y `isReminderDue` discreparan, no se envía.
    if (!isReminderDue(now, { startUtc: row.start_utc as Date, createdAt: row.created_at as Date }, Number(row.cancel_notice_hours))) continue;
    const appointmentId = Number(row.id);
    const queued = await withTransaction(db, async (connection) => {
      const [result] = await connection.execute<ResultSetHeader>(
        "UPDATE appointment SET reminder_enqueued_at = ? WHERE id = ? AND reminder_enqueued_at IS NULL AND status = 'booked'",
        [now, appointmentId],
      );
      if (result.affectedRows !== 1) return false;
      const to = await findNotificationEmailForAppointment(connection, appointmentId);
      if (to) await enqueueEmail(connection, { template: "appointment_reminder", to, payload: { appointmentId } }, clock);
      return to !== null;
    });
    if (queued) enqueued += 1;
  }
  return enqueued;
}
