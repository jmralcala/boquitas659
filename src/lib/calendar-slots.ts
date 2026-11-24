import { localToUtc, weekdayOfLocalDate } from "./zoned-time.js";

/** Configuración vigente del calendario de un médico (valores ya validados). */
export interface CalendarSettings {
  slotMinutes: number;
  gapMinutes: number;
  /** Zona IANA del consultorio. */
  timezone: string;
  minNoticeMinutes: number;
  maxAdvanceDays: number;
  /** Horas antes de la cita hasta las que el paciente puede cancelar (por defecto 24). */
  cancelNoticeHours: number;
}

/** Franja del horario semanal en hora local: 1 = lunes … 7 = domingo; minutos desde las 00:00. */
export interface HoursRange {
  weekday: number;
  startMinute: number;
  endMinute: number;
}

export interface SlotTime {
  startUtc: Date;
  endUtc: Date;
}

export type SlotState = "free" | "booked" | "blocked" | "past";

export interface Slot extends SlotTime {
  state: SlotState;
  /** Cita vigente que se solapa con el espacio (también si el espacio ya pasó), para mostrarla en la agenda. */
  appointmentId?: number;
}

/** Cita vigente: lo único que se necesita para decidir el estado de un espacio. */
export interface AppointmentSpan extends SlotTime {
  id: number;
}

export type BlockSpan = SlotTime;

/**
 * Espacios de un día local. Dentro de cada franja los inicios son `inicio + k × (duración + intervalo)` mientras
 * `inicio + duración ≤ fin`; el intervalo es una pausa, así que los espacios nunca se solapan. Una hora local que no
 * existe (salto de verano) no genera espacio, y los inicios duplicados (hora repetida) se eliminan. Ordenados por inicio.
 */
export function generateSlotsForDay(settings: CalendarSettings, hours: readonly HoursRange[], localDate: string): SlotTime[] {
  const weekday = weekdayOfLocalDate(localDate);
  const step = settings.slotMinutes + settings.gapMinutes;
  const byStart = new Map<number, SlotTime>();
  for (const range of hours) {
    if (range.weekday !== weekday) continue;
    for (let minute = range.startMinute; minute + settings.slotMinutes <= range.endMinute; minute += step) {
      const startUtc = localToUtc(settings.timezone, localDate, minute);
      if (!startUtc) continue;
      byStart.set(startUtc.getTime(), { startUtc, endUtc: new Date(startUtc.getTime() + settings.slotMinutes * 60_000) });
    }
  }
  return [...byStart.values()].sort((a, b) => a.startUtc.getTime() - b.startUtc.getTime());
}

function overlaps(a: SlotTime, b: SlotTime): boolean {
  return a.startUtc.getTime() < b.endUtc.getTime() && a.endUtc.getTime() > b.startUtc.getTime();
}

/**
 * Estado de cada espacio. Orden de decisión: `past` (el inicio ya llegó); `booked` (una cita vigente se solapa);
 * `blocked` (un bloqueo se solapa); si no, `free`. Las citas pasadas conservan su id para mostrarlas.
 */
export function classifySlots(
  slots: readonly SlotTime[],
  appointments: readonly AppointmentSpan[],
  blocks: readonly BlockSpan[],
  now: Date,
): Slot[] {
  return slots.map((slot) => {
    const appointment = appointments.find((candidate) => overlaps(candidate, slot));
    const base: SlotTime = { startUtc: slot.startUtc, endUtc: slot.endUtc };
    const withAppointment = appointment ? { appointmentId: appointment.id } : {};
    if (slot.startUtc.getTime() <= now.getTime()) return { ...base, state: "past", ...withAppointment };
    if (appointment) return { ...base, state: "booked", ...withAppointment };
    if (blocks.some((block) => overlaps(block, slot))) return { ...base, state: "blocked" };
    return { ...base, state: "free" };
  });
}

/** Citas vigentes que no coinciden exactamente (inicio y fin) con ningún espacio de la configuración actual. */
export function findOutOfScheduleAppointments(appointments: readonly AppointmentSpan[], slots: readonly SlotTime[]): AppointmentSpan[] {
  return appointments.filter(
    (appointment) =>
      !slots.some(
        (slot) => slot.startUtc.getTime() === appointment.startUtc.getTime() && slot.endUtc.getTime() === appointment.endUtc.getTime(),
      ),
  );
}
