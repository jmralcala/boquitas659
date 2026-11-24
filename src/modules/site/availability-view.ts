import type { Pool } from "mysql2/promise";
import { ValidationError } from "../../http/errors.js";
import type { TenantContext } from "../../lib/tenant.js";
import { addLocalDays, daysBetweenLocalDates, formatLocalInstant, isValidLocalDate, localDayRangeUtc, utcToLocal } from "../../lib/zoned-time.js";
import { listFreeSlots } from "../calendar/availability.js";
import { listBookedSpansInRange } from "../calendar/appointment-repository.js";
import { listBlockSpansInRange } from "../calendar/block-repository.js";
import { loadSettings } from "../calendar/settings-repository.js";

type Reader = Pick<Pool, "execute">;

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

export interface MonthDay {
  date: string;
  /** Tiene al menos un horario que el paciente puede reservar (anticipación mínima y máxima incluidas). */
  enabled: boolean;
  freeCount: number;
}

export interface MonthView {
  /** `AAAA-MM`. */
  month: string;
  timezone: string;
  days: MonthDay[];
  /** Mes anterior o siguiente navegable; `null` si queda fuera del rango reservable. */
  prevMonth: string | null;
  nextMonth: string | null;
}

export interface DaySlot {
  /** `AAAA-MM-DDTHH:MM` en la hora del consultorio: el valor que se envía al reservar. */
  startLocal: string;
  startUtc: Date;
  endUtc: Date;
}

export interface DayView {
  date: string;
  timezone: string;
  slots: DaySlot[];
}

function monthOf(date: string): string {
  return date.slice(0, 7);
}

function shiftMonth(month: string, delta: number): string {
  const [year, number] = month.split("-").map(Number) as [number, number];
  const moved = new Date(Date.UTC(year, number - 1 + delta, 1));
  return `${moved.getUTCFullYear()}-${String(moved.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Primer y último día reservables (fechas locales del consultorio) para la configuración y el instante dados. */
function reservableRange(timezone: string, maxAdvanceDays: number, now: Date): { today: string; last: string } {
  return {
    today: utcToLocal(timezone, now).date,
    last: utcToLocal(timezone, new Date(now.getTime() + maxAdvanceDays * 86_400_000)).date,
  };
}

/**
 * Mes «tipo aerolínea»: qué días tienen horarios libres para el paciente. Una consulta de citas y una de bloqueos para
 * todo el mes; el cálculo de espacios es el mismo que usa el personal (`listFreeSlots` con `forPatient`). No hay meses
 * pasados ni posteriores a la anticipación máxima: fuera de ese rango lanza `ValidationError` (400).
 */
export async function getMonthView(ctx: TenantContext, db: Reader, month: string, now: Date): Promise<MonthView> {
  if (!MONTH.test(month)) throw new ValidationError({ mes: ["Elige un mes válido."] });
  const { settings, hours } = await loadSettings(ctx, db);
  const range = reservableRange(settings.timezone, settings.maxAdvanceDays, now);
  if (month < monthOf(range.today) || month > monthOf(range.last)) {
    throw new ValidationError({ mes: ["Ese mes no está disponible para reservar."] });
  }

  const first = `${month}-01`;
  const last = addLocalDays(`${shiftMonth(month, 1)}-01`, -1);
  const fromUtc = localDayRangeUtc(settings.timezone, first).start;
  const toUtc = localDayRangeUtc(settings.timezone, last).end;
  const [appointments, blocks] = await Promise.all([listBookedSpansInRange(ctx, db, fromUtc, toUtc), listBlockSpansInRange(ctx, db, fromUtc, toUtc)]);

  const free = listFreeSlots({ settings, hours, appointments, blocks, fromDate: first, toDate: last, now, forPatient: true });
  const counts = new Map<string, number>();
  for (const slot of free) {
    const date = utcToLocal(settings.timezone, slot.startUtc).date;
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }

  const days: MonthDay[] = [];
  for (let date = first; date <= last; date = addLocalDays(date, 1)) {
    const freeCount = counts.get(date) ?? 0;
    days.push({ date, enabled: freeCount > 0, freeCount });
  }
  const prev = shiftMonth(month, -1);
  const next = shiftMonth(month, 1);
  return {
    month,
    timezone: settings.timezone,
    days,
    prevMonth: prev >= monthOf(range.today) ? prev : null,
    nextMonth: next <= monthOf(range.last) ? next : null,
  };
}

/** Horarios libres de un día, en la hora del consultorio. Fechas pasadas, mal formadas o fuera de rango: `ValidationError`. */
export async function getDayView(ctx: TenantContext, db: Reader, date: string, now: Date): Promise<DayView> {
  if (!isValidLocalDate(date)) throw new ValidationError({ fecha: ["Elige una fecha válida."] });
  const { settings, hours } = await loadSettings(ctx, db);
  const range = reservableRange(settings.timezone, settings.maxAdvanceDays, now);
  if (daysBetweenLocalDates(range.today, date) < 0) throw new ValidationError({ fecha: ["No se pueden reservar fechas pasadas."] });
  if (daysBetweenLocalDates(date, range.last) < 0) throw new ValidationError({ fecha: ["Esa fecha todavía no está disponible para reservar."] });

  const { start, end } = localDayRangeUtc(settings.timezone, date);
  const [appointments, blocks] = await Promise.all([listBookedSpansInRange(ctx, db, start, end), listBlockSpansInRange(ctx, db, start, end)]);
  const free = listFreeSlots({ settings, hours, appointments, blocks, fromDate: date, toDate: date, now, forPatient: true });
  return {
    date,
    timezone: settings.timezone,
    slots: free.map((slot) => ({ startLocal: formatLocalInstant(settings.timezone, slot.startUtc), startUtc: slot.startUtc, endUtc: slot.endUtc })),
  };
}
