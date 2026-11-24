/** El recordatorio sale 6 horas antes del límite de cancelación: llega mientras el paciente todavía puede cancelar. */
export const REMINDER_LEAD_HOURS = 6;

const HOUR_MS = 3_600_000;

/** Instante en que debe enviarse el recordatorio: inicio − (límite de cancelación + 6 h). */
export function reminderMoment(startUtc: Date, cancelNoticeHours: number): Date {
  return new Date(startUtc.getTime() - (cancelNoticeHours + REMINDER_LEAD_HOURS) * HOUR_MS);
}

/**
 * ¿Toca enviar el recordatorio ahora? Desde su momento y hasta que empiece la cita, y solo si la cita se creó antes
 * de ese momento (si se reservó más tarde, la confirmación ya cumple su función).
 */
export function isReminderDue(now: Date, appointment: { startUtc: Date; createdAt: Date }, cancelNoticeHours: number): boolean {
  const moment = reminderMoment(appointment.startUtc, cancelNoticeHours).getTime();
  return now.getTime() >= moment && now.getTime() < appointment.startUtc.getTime() && appointment.createdAt.getTime() <= moment;
}
