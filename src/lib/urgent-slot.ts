import {
  classifySlots,
  generateSlotsForDay,
  type AppointmentSpan,
  type BlockSpan,
  type CalendarSettings,
  type HoursRange,
  type SlotKind,
  type SlotTime,
} from "./calendar-slots.js";
import { addLocalDays, utcToLocal } from "./zoned-time.js";

export interface UrgentSlotInput {
  settings: CalendarSettings;
  /** Franjas regulares y de urgencia del médico. */
  hours: readonly HoursRange[];
  /** Citas VIGENTES que se solapan con la ventana (las canceladas no se pasan). */
  appointments: readonly AppointmentSpan[];
  blocks: readonly BlockSpan[];
  now: Date;
  /** Tiempo máximo que puede esperar el nivel (admite fracciones: se compara en milisegundos). */
  windowHours: number;
  /** Anticipación mínima de una urgencia, en minutos. */
  minNoticeMinutes: number;
}

export type UrgentSlot = SlotTime & { kind: SlotKind };

/**
 * Espacio libre MÁS PRÓXIMO para una urgencia: empieza al menos `minNoticeMinutes` después de ahora y a más tardar al
 * terminar la ventana (ambos bordes inclusivos). Considera espacios regulares y de urgencia; a igual inicio gana el de
 * urgencia (se conservan los convencionales). Ignora espacios ocupados, bloqueados, pasados y fuera de horario, y nunca
 * devuelve uno que ya empezó. Las anticipaciones de la reserva convencional NO se aplican. Es pura: no toca la base de
 * datos ni recibe datos de pacientes. `null` si no hay espacio.
 */
export function findNearestUrgentSlot(input: UrgentSlotInput): UrgentSlot | null {
  const earliest = input.now.getTime() + input.minNoticeMinutes * 60_000;
  const latest = input.now.getTime() + input.windowHours * 3_600_000;
  const { timezone } = input.settings;

  const lastDate = utcToLocal(timezone, new Date(latest)).date;
  let best: UrgentSlot | null = null;
  for (let date = utcToLocal(timezone, input.now).date; date <= lastDate; date = addLocalDays(date, 1)) {
    const slots = classifySlots(generateSlotsForDay(input.settings, input.hours, date, ["regular", "urgent"]), input.appointments, input.blocks, input.now);
    for (const slot of slots) {
      if (slot.state !== "free") continue;
      const start = slot.startUtc.getTime();
      if (start < earliest || start > latest) continue;
      const better = best === null || start < best.startUtc.getTime() || (start === best.startUtc.getTime() && slot.kind === "urgent" && best.kind !== "urgent");
      if (better) best = { startUtc: slot.startUtc, endUtc: slot.endUtc, kind: slot.kind ?? "regular" };
    }
  }
  return best;
}
