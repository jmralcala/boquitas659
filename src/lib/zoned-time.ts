/**
 * Conversión entre la hora local del consultorio y UTC con `Intl`, sin dependencias. Las horas se guardan en UTC y se
 * muestran en la zona del consultorio (principio III). Una hora local puede no existir (salto de verano) o repetirse
 * (retroceso): `localToUtc` devuelve `null` en el primer caso y la primera ocurrencia en el segundo.
 */

/** Zonas admitidas: lista cerrada de zonas de México (research.md, decisión 2). */
export const ALLOWED_TIMEZONES = [
  "America/Mexico_City",
  "America/Cancun",
  "America/Merida",
  "America/Monterrey",
  "America/Chihuahua",
  "America/Ciudad_Juarez",
  "America/Hermosillo",
  "America/Mazatlan",
  "America/Tijuana",
  "America/Matamoros",
  "America/Bahia_Banderas",
  "America/Ojinaga",
] as const;

export type AllowedTimezone = (typeof ALLOWED_TIMEZONES)[number];

export const DEFAULT_TIMEZONE: AllowedTimezone = "America/Mexico_City";

export function isAllowedTimezone(zone: string): zone is AllowedTimezone {
  return (ALLOWED_TIMEZONES as readonly string[]).includes(zone);
}

export interface LocalParts {
  /** AAAA-MM-DD en la zona. */
  date: string;
  /** Minutos desde las 00:00 locales. */
  minutesOfDay: number;
  /** 1 = lunes … 7 = domingo. */
  weekday: number;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Verdadero si es una fecha de calendario real con formato AAAA-MM-DD. */
export function isValidLocalDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function dateToParts(value: string): { year: number; month: number; day: number } | null {
  if (!isValidLocalDate(value)) return null;
  const match = DATE_PATTERN.exec(value);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

/** Suma días de calendario a una fecha local (aritmética de fechas, sin horas: inmune a los cambios de hora). */
export function addLocalDays(date: string, days: number): string {
  const parts = dateToParts(date);
  if (!parts) throw new Error("Fecha local inválida.");
  const moved = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return `${pad(moved.getUTCFullYear(), 4)}-${pad(moved.getUTCMonth() + 1)}-${pad(moved.getUTCDate())}`;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

function weekdayOf(year: number, month: number, day: number): number {
  const sundayFirst = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return sundayFirst === 0 ? 7 : sundayFirst;
}

/** Fecha, minutos del día y día de la semana de un instante en la zona dada. */
export function utcToLocal(zone: string, instant: Date): LocalParts {
  const values: Record<string, number> = {};
  for (const part of formatterFor(zone).formatToParts(instant)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  const { year, month, day, hour, minute } = values;
  if (year === undefined || month === undefined || day === undefined || hour === undefined || minute === undefined) {
    throw new Error("No se pudo convertir el instante a hora local.");
  }
  return {
    date: `${pad(year, 4)}-${pad(month)}-${pad(day)}`,
    minutesOfDay: hour * 60 + minute,
    weekday: weekdayOf(year, month, day),
  };
}

/** Desfase (minutos) de la zona respecto a UTC en un instante: hora local − hora UTC. */
function offsetMinutesAt(zone: string, instant: Date): number {
  const values: Record<string, number> = {};
  for (const part of formatterFor(zone).formatToParts(instant)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(values.year ?? 0, (values.month ?? 1) - 1, values.day ?? 1, values.hour ?? 0, values.minute ?? 0, values.second ?? 0);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

/**
 * Instante UTC de una hora local. `null` si la fecha no existe, los minutos están fuera de 0–1440 o esa hora local
 * no existe en la zona (salto de verano). Una hora repetida devuelve la primera ocurrencia. 1440 es la medianoche
 * del día siguiente.
 */
export function localToUtc(zone: string, date: string, minutesOfDay: number): Date | null {
  if (!Number.isInteger(minutesOfDay) || minutesOfDay < 0 || minutesOfDay > 1440) return null;
  if (minutesOfDay === 1440) return localToUtc(zone, addLocalDays(date, 1), 0);
  const parts = dateToParts(date);
  if (!parts) return null;
  const naive = Date.UTC(parts.year, parts.month - 1, parts.day, 0, minutesOfDay);
  // Los desfases un día antes y un día después cubren ambos lados de cualquier cambio de hora cercano.
  const offsets = new Set([offsetMinutesAt(zone, new Date(naive - 86_400_000)), offsetMinutesAt(zone, new Date(naive + 86_400_000))]);
  const matches: number[] = [];
  for (const offset of offsets) {
    const candidate = naive - offset * 60_000;
    const local = utcToLocal(zone, new Date(candidate));
    if (local.date === date && local.minutesOfDay === minutesOfDay) matches.push(candidate);
  }
  if (matches.length === 0) return null;
  return new Date(Math.min(...matches));
}

/** Primer instante del día local (si la medianoche no existiera en la zona, el primer minuto que sí existe). */
function startOfLocalDay(zone: string, date: string): Date {
  for (let minute = 0; minute < 24 * 60; minute += 1) {
    const instant = localToUtc(zone, date, minute);
    if (instant) return instant;
  }
  throw new Error("El día local no tiene ningún instante válido.");
}

/** Rango UTC [inicio, fin) de un día local; el día de un cambio de hora dura 23 o 25 horas. */
export function localDayRangeUtc(zone: string, date: string): { start: Date; end: Date } {
  return { start: startOfLocalDay(zone, date), end: startOfLocalDay(zone, addLocalDays(date, 1)) };
}

/** Día de la semana de una fecha de calendario (1 = lunes … 7 = domingo). */
export function weekdayOfLocalDate(date: string): number {
  const parts = dateToParts(date);
  if (!parts) throw new Error("Fecha local inválida.");
  return weekdayOf(parts.year, parts.month, parts.day);
}

/** `AAAA-MM-DDTHH:MM` local de un instante en la zona dada (así viajan los instantes entre la interfaz y el servidor). */
export function formatLocalInstant(zone: string, instant: Date): string {
  const local = utcToLocal(zone, instant);
  const hours = Math.floor(local.minutesOfDay / 60);
  return `${local.date}T${pad(hours)}:${pad(local.minutesOfDay % 60)}`;
}

/** Días de calendario de `from` a `to` (positivo si `to` es posterior). Ambas son fechas locales AAAA-MM-DD. */
export function daysBetweenLocalDates(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000);
}
