import type { Db } from "../../db/pool.js";
import { ValidationError } from "../../http/errors.js";
import {
  classifySlots,
  findOutOfScheduleAppointments,
  generateSlotsForDay,
  type CalendarSettings,
  type HoursRange,
  type Slot,
} from "../../lib/calendar-slots.js";
import type { TenantContext } from "../../lib/tenant.js";
import { addLocalDays, daysBetweenLocalDates, isValidLocalDate, localDayRangeUtc, utcToLocal, weekdayOfLocalDate } from "../../lib/zoned-time.js";
import { listBookedInRange, type AppointmentRecord } from "./appointment-repository.js";
import { listBlocksInRange, type BlockRecord } from "./block-repository.js";
import { loadSettings } from "./settings-repository.js";

/** Cuánto se puede consultar la agenda: 730 días hacia adelante y 365 hacia atrás (spec, Supuestos). */
export const MAX_DAYS_AHEAD = 730;
export const MAX_DAYS_BACK = 365;

/** Cita tal como la muestra la agenda: el nombre es el único dato personal. */
export interface AgendaAppointment {
  id: number;
  patientId: number;
  patientName: string;
  startUtc: Date;
  endUtc: Date;
  /** La cita ya no coincide con ningún espacio de la configuración vigente (se conserva y se marca). */
  outOfSchedule: boolean;
}

export interface AgendaBlock {
  id: number;
  startUtc: Date;
  endUtc: Date;
  reason: string | null;
}

export interface AgendaDay {
  date: string;
  timezone: string;
  weekday: number;
  slots: Slot[];
  appointments: AgendaAppointment[];
  blocks: AgendaBlock[];
  previousDate: string;
  nextDate: string;
}

export interface AgendaWeek {
  timezone: string;
  /** Lunes de la semana. */
  startDate: string;
  days: AgendaDay[];
  previousDate: string;
  nextDate: string;
}

/** Valida que la fecha exista y esté dentro del rango consultable (hoy local ± topes). */
function assertConsultable(localDate: string, today: string): void {
  if (!isValidLocalDate(localDate)) throw new ValidationError({ fecha: ["La fecha no es válida."] });
  const difference = daysBetweenLocalDates(today, localDate);
  if (difference > MAX_DAYS_AHEAD) throw new ValidationError({ fecha: [`Solo se puede consultar hasta ${MAX_DAYS_AHEAD} días hacia adelante.`] });
  if (difference < -MAX_DAYS_BACK) throw new ValidationError({ fecha: [`Solo se puede consultar hasta ${MAX_DAYS_BACK} días hacia atrás.`] });
}

function toAgendaBlock(block: BlockRecord): AgendaBlock {
  return { id: block.id, startUtc: block.startUtc, endUtc: block.endUtc, reason: block.reason };
}

function buildDay(
  localDate: string,
  settings: CalendarSettings,
  hours: readonly HoursRange[],
  appointments: readonly AppointmentRecord[],
  blocks: readonly BlockRecord[],
  now: Date,
): AgendaDay {
  const { start, end } = localDayRangeUtc(settings.timezone, localDate);
  const baseSlots = generateSlotsForDay(settings, hours, localDate);
  // El estado de un espacio usa todas las citas que se le solapan (aunque empiecen otro día local).
  const slots = classifySlots(baseSlots, appointments, blocks, now);
  // Las citas de un día son las que EMPIEZAN en él (hora local del consultorio).
  const ofDay = appointments.filter((a) => a.startUtc.getTime() >= start.getTime() && a.startUtc.getTime() < end.getTime());
  const outOfSchedule = new Set(findOutOfScheduleAppointments(ofDay, baseSlots).map((a) => a.id));
  return {
    date: localDate,
    timezone: settings.timezone,
    weekday: weekdayOfLocalDate(localDate),
    slots,
    appointments: ofDay.map((a) => ({
      id: a.id,
      patientId: a.patientId,
      patientName: a.patientName,
      startUtc: a.startUtc,
      endUtc: a.endUtc,
      outOfSchedule: outOfSchedule.has(a.id),
    })),
    blocks: blocks.filter((b) => b.startUtc.getTime() < end.getTime() && b.endUtc.getTime() > start.getTime()).map(toAgendaBlock),
    previousDate: addLocalDays(localDate, -1),
    nextDate: addLocalDays(localDate, 1),
  };
}

/** Agenda de un día local del consultorio: espacios con su estado, citas (nombre del paciente) y bloqueos. */
export async function getDay(ctx: TenantContext, db: Db, localDate: string, now: Date): Promise<AgendaDay> {
  const { settings, hours } = await loadSettings(ctx, db);
  assertConsultable(localDate, utcToLocal(settings.timezone, now).date);
  const { start, end } = localDayRangeUtc(settings.timezone, localDate);
  const [appointments, blocks] = await Promise.all([listBookedInRange(ctx, db, start, end), listBlocksInRange(ctx, db, start, end)]);
  return buildDay(localDate, settings, hours, appointments, blocks, now);
}

/** Agenda de la semana (lunes a domingo) que contiene `localDate`, con una sola consulta de citas y de bloqueos. */
export async function getWeek(ctx: TenantContext, db: Db, localDate: string, now: Date): Promise<AgendaWeek> {
  const { settings, hours } = await loadSettings(ctx, db);
  assertConsultable(localDate, utcToLocal(settings.timezone, now).date);
  const monday = addLocalDays(localDate, -(weekdayOfLocalDate(localDate) - 1));
  const dates = Array.from({ length: 7 }, (_unused, index) => addLocalDays(monday, index));
  const from = localDayRangeUtc(settings.timezone, monday).start;
  const to = localDayRangeUtc(settings.timezone, addLocalDays(monday, 7)).start;
  const [appointments, blocks] = await Promise.all([listBookedInRange(ctx, db, from, to), listBlocksInRange(ctx, db, from, to)]);
  return {
    timezone: settings.timezone,
    startDate: monday,
    days: dates.map((date) => buildDay(date, settings, hours, appointments, blocks, now)),
    previousDate: addLocalDays(monday, -7),
    nextDate: addLocalDays(monday, 7),
  };
}
