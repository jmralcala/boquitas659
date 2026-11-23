import {
  classifySlots,
  generateSlotsForDay,
  type AppointmentSpan,
  type BlockSpan,
  type CalendarSettings,
  type HoursRange,
  type SlotTime,
} from "../../lib/calendar-slots.js";
import { addLocalDays } from "../../lib/zoned-time.js";

/** Motivo por el que una reserva hecha por un PACIENTE queda fuera de la ventana de anticipación del médico. */
export type BookingWindowViolation = "too_soon" | "too_far";

/**
 * Comprobación en el servidor de la anticipación de reserva de un PACIENTE (principio III de la constitución): el
 * espacio debe empezar al menos `minNoticeMinutes` después de ahora y como máximo `maxAdvanceDays` días después.
 * El borde es inclusivo: justo en el límite se acepta. El personal del consultorio (médico y recepción) NO pasa por
 * esta regla: solo por «espacio futuro y libre». La reserva por el paciente es la feature 3, que debe llamar a esta
 * función en su ruta de reserva.
 */
export function validatePatientBookingWindow(
  settings: Pick<CalendarSettings, "minNoticeMinutes" | "maxAdvanceDays">,
  startUtc: Date,
  now: Date,
): { ok: true } | { ok: false; reason: BookingWindowViolation } {
  const earliest = now.getTime() + settings.minNoticeMinutes * 60_000;
  const latest = now.getTime() + settings.maxAdvanceDays * 86_400_000;
  if (startUtc.getTime() < earliest) return { ok: false, reason: "too_soon" };
  if (startUtc.getTime() > latest) return { ok: false, reason: "too_far" };
  return { ok: true };
}

export interface FreeSlotsInput {
  settings: CalendarSettings;
  hours: readonly HoursRange[];
  appointments: readonly AppointmentSpan[];
  blocks: readonly BlockSpan[];
  /** Primer y último día local (AAAA-MM-DD, ambos incluidos). */
  fromDate: string;
  toDate: string;
  now: Date;
  /** Si es verdadero se aplican además las anticipaciones del médico (reserva hecha por un paciente). */
  forPatient: boolean;
}

/** Espacios libres entre dos fechas locales. Para pacientes, solo los que cumplen la anticipación mínima y máxima. */
export function listFreeSlots(input: FreeSlotsInput): SlotTime[] {
  const free: SlotTime[] = [];
  for (let date = input.fromDate; date <= input.toDate; date = addLocalDays(date, 1)) {
    const slots = classifySlots(generateSlotsForDay(input.settings, input.hours, date), input.appointments, input.blocks, input.now);
    for (const slot of slots) {
      if (slot.state !== "free") continue;
      if (input.forPatient && !validatePatientBookingWindow(input.settings, slot.startUtc, input.now).ok) continue;
      free.push({ startUtc: slot.startUtc, endUtc: slot.endUtc });
    }
  }
  return free;
}
