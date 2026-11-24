import { describe, expect, it } from "vitest";
import type { AppointmentSpan, BlockSpan, CalendarSettings, HoursRange } from "../../src/lib/calendar-slots.js";
import { findNearestUrgentSlot } from "../../src/lib/urgent-slot.js";

const MX = "America/Mexico_City";
const HOUR = 3_600_000;

function settings(overrides: Partial<CalendarSettings> = {}): CalendarSettings {
  return { slotMinutes: 45, gapMinutes: 15, timezone: MX, minNoticeMinutes: 120, maxAdvanceDays: 60, cancelNoticeHours: 24, urgentMinNoticeMinutes: 30, ...overrides };
}

const hm = (hours: number): number => hours * 60;
const regular = (weekday: number, start: number, end: number): HoursRange => ({ weekday, startMinute: start, endMinute: end, kind: "regular" });
const urgent = (weekday: number, start: number, end: number): HoursRange => ({ weekday, startMinute: start, endMinute: end, kind: "urgent" });

// Lunes 2026-06-15, 8:00 en Ciudad de México (UTC−6) = 14:00Z.
const NOW = new Date("2026-06-15T14:00:00.000Z");
const local = (date: string, hour: number): Date => new Date(`${date}T${String(hour + 6).padStart(2, "0")}:00:00.000Z`);
const span = (id: number, from: Date): AppointmentSpan => ({ id, startUtc: from, endUtc: new Date(from.getTime() + 45 * 60_000) });
const block = (from: Date, hours: number): BlockSpan => ({ startUtc: from, endUtc: new Date(from.getTime() + hours * HOUR) });

function find(over: Partial<Parameters<typeof findNearestUrgentSlot>[0]> = {}) {
  return findNearestUrgentSlot({
    settings: settings(),
    hours: [regular(1, hm(9), hm(14)), urgent(1, hm(15), hm(17))],
    appointments: [],
    blocks: [],
    now: NOW,
    windowHours: 12,
    minNoticeMinutes: 30,
    ...over,
  });
}

describe("findNearestUrgentSlot", () => {
  it("devuelve el espacio libre más próximo después de la anticipación mínima", () => {
    // 8:00 + 30 min → 8:30; el primero es el de las 9:00 (regular).
    const slot = find();
    expect(slot?.startUtc.toISOString()).toBe(local("2026-06-15", 9).toISOString());
    expect(slot?.kind).toBe("regular");
    expect((slot?.endUtc.getTime() ?? 0) - (slot?.startUtc.getTime() ?? 0)).toBe(45 * 60_000);
  });

  it("el borde de la anticipación mínima es inclusivo y un minuto antes no se acepta", () => {
    // Anticipación de 60 minutos: 9:00 justo en el límite → se acepta.
    expect(find({ minNoticeMinutes: 60 })?.startUtc.toISOString()).toBe(local("2026-06-15", 9).toISOString());
    // 61 minutos: el espacio de las 9:00 queda a un minuto de cumplirla → siguiente.
    expect(find({ minNoticeMinutes: 61 })?.startUtc.toISOString()).toBe(local("2026-06-15", 10).toISOString());
  });

  it("el borde de la ventana es inclusivo", () => {
    const hours = [regular(1, hm(10), hm(11))];
    // Ventana de 2 h desde las 8:00 → hasta las 10:00 inclusive: el espacio de las 10:00 entra.
    expect(find({ hours, windowHours: 2 })?.startUtc.toISOString()).toBe(local("2026-06-15", 10).toISOString());
    // Un poco menos de 2 h: queda fuera.
    expect(find({ hours, windowHours: 1.99 })).toBeNull();
  });

  it("a igual inicio gana el espacio de urgencia, también si la franja regular va después en la lista", () => {
    const hours = [regular(1, hm(10), hm(11)), urgent(1, hm(10), hm(11))];
    expect(find({ hours })?.kind).toBe("urgent");
    expect(find({ hours: [...hours].reverse() })?.kind).toBe("urgent");
  });

  it("si el espacio convencional es más próximo, gana el convencional", () => {
    const hours = [urgent(1, hm(11), hm(12)), regular(1, hm(10), hm(11))];
    const slot = find({ hours });
    expect(slot?.kind).toBe("regular");
    expect(slot?.startUtc.toISOString()).toBe(local("2026-06-15", 10).toISOString());
  });

  it("ignora los espacios ocupados y los bloqueados", () => {
    const appointments = [span(1, local("2026-06-15", 9)), span(2, local("2026-06-15", 10))];
    const blocks = [block(local("2026-06-15", 11), 1)];
    expect(find({ appointments, blocks })?.startUtc.toISOString()).toBe(local("2026-06-15", 12).toISOString());
  });

  it("nunca devuelve un espacio pasado o que ya empezó, ni con anticipación 0", () => {
    const slot = find({ now: local("2026-06-15", 9), minNoticeMinutes: 0, hours: [regular(1, hm(9), hm(14))] });
    // Justo a las 9:00 el espacio de las 9:00 ya empezó (no es posterior a ahora): el siguiente es el de las 10:00.
    expect(slot?.startUtc.toISOString()).toBe(local("2026-06-15", 10).toISOString());
  });

  it("no devuelve espacios fuera del horario ni sin franjas", () => {
    expect(find({ hours: [] })).toBeNull();
    expect(find({ hours: [regular(2, hm(9), hm(14))], windowHours: 2 })).toBeNull(); // franja de martes, ventana de hoy
  });

  it("busca en días siguientes y a través de la medianoche", () => {
    const hours = [regular(2, hm(9), hm(10))]; // martes
    const slot = find({ hours, windowHours: 72 });
    expect(slot?.startUtc.toISOString()).toBe(local("2026-06-16", 9).toISOString());
    expect(find({ hours, windowHours: 24 })).toBeNull(); // martes 9:00 queda 25 h después
  });

  it("con todo ocupado en la ventana devuelve null", () => {
    const appointments = [9, 10, 11, 12, 13].map((hour, index) => span(index + 1, local("2026-06-15", hour)));
    expect(find({ hours: [regular(1, hm(9), hm(14))], appointments, windowHours: 6 })).toBeNull();
  });

  it("el cambio de hora (primavera, America/Tijuana) no duplica ni asigna la hora que no existe", () => {
    // 2026-03-08 (domingo): a las 2:00 locales los relojes saltan a las 3:00. Ahora: sábado 23:00 local (PST = UTC−8).
    const now = new Date("2026-03-08T07:00:00.000Z");
    const hours = [urgent(7, hm(0), hm(6))];
    const seen = new Set<number>();
    const cursor = now;
    for (let index = 0; index < 5; index += 1) {
      const slot = findNearestUrgentSlot({ settings: settings({ timezone: "America/Tijuana" }), hours, appointments: [...seen].map((start, id) => span(id, new Date(start))), blocks: [], now: cursor, windowHours: 12, minNoticeMinutes: 0 });
      expect(slot).not.toBeNull();
      expect(seen.has(slot?.startUtc.getTime() ?? 0)).toBe(false);
      seen.add(slot?.startUtc.getTime() ?? 0);
      const local = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Tijuana", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(slot?.startUtc);
      expect(local).not.toBe("02:00");
    }
  });

  it("el resultado solo trae el intervalo y el tipo, nunca datos de pacientes", () => {
    expect(Object.keys(find() ?? {}).sort()).toEqual(["endUtc", "kind", "startUtc"]);
  });
});
