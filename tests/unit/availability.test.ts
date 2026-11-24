import { describe, expect, it } from "vitest";
import { listFreeSlots, validatePatientBookingWindow } from "../../src/modules/calendar/availability.js";

const NOW = new Date("2026-06-15T18:00:00.000Z");
const SETTINGS = { minNoticeMinutes: 120, maxAdvanceDays: 60 };
const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);

describe("validatePatientBookingWindow", () => {
  it("rechaza un espacio dentro de la anticipación mínima", () => {
    expect(validatePatientBookingWindow(SETTINGS, at(60 * 60_000), NOW)).toEqual({ ok: false, reason: "too_soon" });
    expect(validatePatientBookingWindow(SETTINGS, NOW, NOW)).toEqual({ ok: false, reason: "too_soon" });
    expect(validatePatientBookingWindow(SETTINGS, at(-60_000), NOW)).toEqual({ ok: false, reason: "too_soon" });
  });

  it("justo en el límite mínimo se acepta; un milisegundo antes, no", () => {
    expect(validatePatientBookingWindow(SETTINGS, at(120 * 60_000), NOW)).toEqual({ ok: true });
    expect(validatePatientBookingWindow(SETTINGS, at(120 * 60_000 - 1), NOW)).toEqual({ ok: false, reason: "too_soon" });
  });

  it("justo en el límite máximo se acepta; un instante después, no", () => {
    expect(validatePatientBookingWindow(SETTINGS, at(60 * 86_400_000), NOW)).toEqual({ ok: true });
    expect(validatePatientBookingWindow(SETTINGS, at(60 * 86_400_000 + 1), NOW)).toEqual({ ok: false, reason: "too_far" });
  });

  it("acepta un espacio dentro de la ventana", () => {
    expect(validatePatientBookingWindow(SETTINGS, at(3 * 86_400_000), NOW)).toEqual({ ok: true });
  });

  it("usa las anticipaciones de cada médico", () => {
    const strict = { minNoticeMinutes: 24 * 60, maxAdvanceDays: 7 };
    const tomorrowMorning = at(20 * 3_600_000);
    expect(validatePatientBookingWindow(SETTINGS, tomorrowMorning, NOW)).toEqual({ ok: true });
    expect(validatePatientBookingWindow(strict, tomorrowMorning, NOW)).toEqual({ ok: false, reason: "too_soon" });
    expect(validatePatientBookingWindow(strict, at(10 * 86_400_000), NOW)).toEqual({ ok: false, reason: "too_far" });
  });

  it("con mínima 0 se puede reservar de inmediato", () => {
    expect(validatePatientBookingWindow({ minNoticeMinutes: 0, maxAdvanceDays: 30 }, at(1), NOW)).toEqual({ ok: true });
  });
});

describe("listFreeSlots", () => {
  const settings = { slotMinutes: 45, gapMinutes: 15, timezone: "America/Mexico_City", minNoticeMinutes: 24 * 60, maxAdvanceDays: 3, cancelNoticeHours: 24, urgentMinNoticeMinutes: 30 };
  const hours = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 11 * 60 })); // 9:00 y 10:00
  const now = new Date("2026-06-15T15:00:00.000Z"); // lunes 9:00 locales
  const base = { settings, hours, appointments: [], blocks: [], fromDate: "2026-06-15", toDate: "2026-06-20", now };

  it("para el personal devuelve todos los espacios libres futuros, sin aplicar anticipaciones", () => {
    const slots = listFreeSlots({ ...base, forPatient: false });
    // Lunes: 9:00 ya empezó (pasado); queda 10:00. Martes a sábado: 2 por día.
    expect(slots).toHaveLength(1 + 2 * 5);
    expect(slots[0]?.startUtc.toISOString()).toBe("2026-06-15T16:00:00.000Z");
  });

  it("para pacientes aplica la anticipación mínima (24 h) y la máxima (3 días)", () => {
    const slots = listFreeSlots({ ...base, forPatient: true }).map((s) => s.startUtc.toISOString());
    // Desde lunes 9:00 + 24 h = martes 9:00 (incluido) hasta jueves 9:00 (incluido).
    expect(slots).toEqual([
      "2026-06-16T15:00:00.000Z",
      "2026-06-16T16:00:00.000Z",
      "2026-06-17T15:00:00.000Z",
      "2026-06-17T16:00:00.000Z",
      "2026-06-18T15:00:00.000Z",
    ]);
  });

  it("excluye los espacios ocupados y bloqueados", () => {
    const slots = listFreeSlots({
      ...base,
      forPatient: false,
      fromDate: "2026-06-16",
      toDate: "2026-06-16",
      appointments: [{ id: 1, startUtc: new Date("2026-06-16T15:00:00.000Z"), endUtc: new Date("2026-06-16T15:45:00.000Z") }],
    });
    expect(slots.map((s) => s.startUtc.toISOString())).toEqual(["2026-06-16T16:00:00.000Z"]);
    const blocked = listFreeSlots({
      ...base,
      forPatient: false,
      fromDate: "2026-06-16",
      toDate: "2026-06-16",
      blocks: [{ startUtc: new Date("2026-06-16T15:00:00.000Z"), endUtc: new Date("2026-06-16T17:00:00.000Z") }],
    });
    expect(blocked).toEqual([]);
  });
});

describe("listFreeSlots con franjas de urgencia", () => {
  const settings = { slotMinutes: 45, gapMinutes: 15, timezone: "America/Mexico_City", minNoticeMinutes: 120, maxAdvanceDays: 60, cancelNoticeHours: 24, urgentMinNoticeMinutes: 30 };
  const hours = [
    { weekday: 2, startMinute: 9 * 60, endMinute: 11 * 60 },
    { weekday: 2, startMinute: 8 * 60, endMinute: 9 * 60, kind: "urgent" as const },
  ];

  it("ofrece solo los espacios regulares: el calendario convencional no ve los de urgencia", () => {
    const free = listFreeSlots({ settings, hours, appointments: [], blocks: [], fromDate: "2026-06-16", toDate: "2026-06-16", now: NOW, forPatient: false });
    // Martes 2026-06-16 en la Ciudad de México: 9:00 y 10:00 locales (15:00Z y 16:00Z); la franja de urgencia de las 8:00 no aparece.
    expect(free.map((slot) => slot.startUtc.toISOString())).toEqual(["2026-06-16T15:00:00.000Z", "2026-06-16T16:00:00.000Z"]);
  });

  it("tampoco ofrece los de urgencia a un paciente (forPatient)", () => {
    const free = listFreeSlots({ settings, hours, appointments: [], blocks: [], fromDate: "2026-06-16", toDate: "2026-06-16", now: NOW, forPatient: true });
    expect(free.map((slot) => slot.startUtc.toISOString())).toEqual(["2026-06-16T15:00:00.000Z", "2026-06-16T16:00:00.000Z"]);
  });
});
