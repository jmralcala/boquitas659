import { z } from "zod";
import { ValidationError } from "../../http/errors.js";
import type { CalendarSettings, HoursRange } from "../../lib/calendar-slots.js";
import { DEFAULT_TIMEZONE, isAllowedTimezone } from "../../lib/zoned-time.js";

/** Valores por defecto de un médico sin configuración guardada (decisión 0001, supuesto 12; ajustables). */
export const DEFAULT_SETTINGS: CalendarSettings = {
  slotMinutes: 45,
  gapMinutes: 15,
  timezone: DEFAULT_TIMEZONE,
  minNoticeMinutes: 120,
  maxAdvanceDays: 60,
  cancelNoticeHours: 24,
};

/** Configuración vigente de un calendario: valores, franjas y si todavía rigen los valores por defecto. */
export interface CalendarConfig {
  settings: CalendarSettings;
  hours: HoursRange[];
  /** Verdadero mientras el médico no ha guardado su configuración. */
  isDefault: boolean;
}

/** Lo que se guarda: configuración ya validada y franjas en minutos. */
export interface CalendarInput {
  settings: CalendarSettings;
  hours: HoursRange[];
}

/** Límites de la configuración (spec FR-003 a FR-005); la base de datos los repite con CHECK. */
export const LIMITS = {
  slotMinutes: { min: 15, max: 180, step: 5 },
  gapMinutes: { min: 0, max: 60, step: 5 },
  minNoticeHours: { min: 0, max: 168 },
  maxAdvanceDays: { min: 1, max: 365 },
  cancelNoticeHours: { min: 0, max: 168 },
  rangesPerDay: 4,
} as const;

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
const SLOTS_PER_DAY = LIMITS.rangesPerDay;

function integer(label: string, min: number, max: number, step = 1): z.ZodType<number> {
  const stepText = step > 1 ? ` en pasos de ${step}` : "";
  const name = `${label[0]?.toUpperCase() ?? ""}${label.slice(1)}`;
  const range = `${name} debe estar entre ${min} y ${max}${stepText}.`;
  // Solo dígitos: sin notación científica, hexadecimal, signos ni decimales.
  const digitsOnly = z.preprocess(
    (value) => (typeof value === "string" && /^\d{1,6}$/.test(value.trim()) ? Number(value.trim()) : Number.NaN),
    z.number({ error: `Escribe un número para ${label}.` }),
  );
  return digitsOnly.pipe(
    z
      .number()
      .int(`${name} debe ser un número entero.`)
      .min(min, range)
      .max(max, range)
      .refine((value) => value % step === 0, range),
  );
}

const TIME = /^(\d{2}):(\d{2})$/;

/** `HH:MM` → minutos desde las 00:00; `null` si el formato o los valores no son válidos (se permite 24:00). */
function toMinutes(value: string): number | null {
  const match = TIME.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (minutes > 59 || hours > 24 || (hours === 24 && minutes !== 0)) return null;
  return hours * 60 + minutes;
}

const formSchema = z.object({
  slotMinutes: integer("la duración", LIMITS.slotMinutes.min, LIMITS.slotMinutes.max, LIMITS.slotMinutes.step),
  gapMinutes: integer("el intervalo", LIMITS.gapMinutes.min, LIMITS.gapMinutes.max, LIMITS.gapMinutes.step),
  timezone: z.string().refine(isAllowedTimezone, "Elige una zona horaria de la lista."),
  minNoticeHours: integer("la anticipación mínima", LIMITS.minNoticeHours.min, LIMITS.minNoticeHours.max),
  maxAdvanceDays: integer("la anticipación máxima", LIMITS.maxAdvanceDays.min, LIMITS.maxAdvanceDays.max),
  cancelNoticeHours: integer("el límite de cancelación", LIMITS.cancelNoticeHours.min, LIMITS.cancelNoticeHours.max),
});

/** Clave del campo de una franja en el formulario: `h<día>_<n>_start|end`; los errores de la franja usan `h<día>_<n>`. */
export function rangeFieldName(weekday: number, slot: number, edge: "start" | "end"): string {
  return `h${weekday}_${slot}_${edge}`;
}

function textOf(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value.trim().slice(0, 10) : "";
}

/**
 * Valida el formulario de configuración (cuerpo plano: `slotMinutes`, `gapMinutes`, `timezone`, `minNoticeHours`,
 * `maxAdvanceDays` y hasta 4 franjas por día `h<día>_<n>_start|end`) y devuelve lo que se guarda. Lanza
 * `ValidationError` con un mensaje por campo y sin repetir nunca los valores recibidos.
 */
export function parseCalendarForm(body: Record<string, unknown>): CalendarInput {
  const errors: Record<string, string[]> = {};
  const add = (key: string, message: string): void => {
    const list = (errors[key] ??= []);
    if (!list.includes(message)) list.push(message);
  };

  const parsed = formSchema.safeParse({
    slotMinutes: typeof body.slotMinutes === "string" ? body.slotMinutes.slice(0, 10) : undefined,
    gapMinutes: typeof body.gapMinutes === "string" ? body.gapMinutes.slice(0, 10) : undefined,
    timezone: typeof body.timezone === "string" ? body.timezone.slice(0, 64) : "",
    minNoticeHours: typeof body.minNoticeHours === "string" ? body.minNoticeHours.slice(0, 10) : undefined,
    maxAdvanceDays: typeof body.maxAdvanceDays === "string" ? body.maxAdvanceDays.slice(0, 10) : undefined,
    // Si el campo no viene (formularios anteriores a esta versión) rige el valor por defecto.
    cancelNoticeHours: typeof body.cancelNoticeHours === "string" ? body.cancelNoticeHours.slice(0, 10) : String(DEFAULT_SETTINGS.cancelNoticeHours),
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) add(String(issue.path[0] ?? "_"), issue.message);
  }

  // Franjas: cada par inicio/fin se valida por separado; vacío + vacío se ignora.
  const ranges: HoursRange[] = [];
  for (const weekday of WEEKDAYS) {
    const day: { slot: number; start: number; end: number }[] = [];
    for (let slot = 0; slot < SLOTS_PER_DAY; slot += 1) {
      const startText = textOf(body, rangeFieldName(weekday, slot, "start"));
      const endText = textOf(body, rangeFieldName(weekday, slot, "end"));
      if (startText === "" && endText === "") continue;
      const key = `h${weekday}_${slot}`;
      if (startText === "" || endText === "") {
        add(key, "Escribe la hora de inicio y la de fin, o deja ambas vacías.");
        continue;
      }
      const start = toMinutes(startText);
      const end = toMinutes(endText);
      if (start === null || end === null || start >= 1440) {
        add(key, "Las horas deben tener el formato HH:MM (24 horas).");
        continue;
      }
      if (start % 5 !== 0 || end % 5 !== 0) {
        add(key, "Los minutos deben ser múltiplos de 5.");
        continue;
      }
      if (end <= start) {
        add(key, "La hora de fin debe ser posterior a la de inicio.");
        continue;
      }
      day.push({ slot, start, end });
    }
    // Un día no puede tener franjas solapadas (las adyacentes sí valen).
    const sorted = [...day].sort((a, b) => a.start - b.start);
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      if (previous && current && current.start < previous.end) {
        add(`h${weekday}_${current.slot}`, "Las franjas de un mismo día no pueden solaparse.");
      }
    }
    for (const entry of sorted) ranges.push({ weekday, startMinute: entry.start, endMinute: entry.end });
  }

  if (parsed.success && parsed.data.minNoticeHours * 60 >= parsed.data.maxAdvanceDays * 1440) {
    add("minNoticeHours", "La anticipación mínima debe ser menor que la máxima.");
  }

  if (Object.keys(errors).length > 0 || !parsed.success) throw new ValidationError(errors);

  return {
    settings: {
      slotMinutes: parsed.data.slotMinutes,
      gapMinutes: parsed.data.gapMinutes,
      timezone: parsed.data.timezone,
      minNoticeMinutes: parsed.data.minNoticeHours * 60,
      maxAdvanceDays: parsed.data.maxAdvanceDays,
      cancelNoticeHours: parsed.data.cancelNoticeHours,
    },
    hours: ranges,
  };
}
