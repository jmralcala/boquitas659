import { describe, expect, it } from "vitest";
import {
  classifySlots,
  findOutOfScheduleAppointments,
  generateSlotsForDay,
  type CalendarSettings,
  type HoursRange,
} from "../../src/lib/calendar-slots.js";
import { localToUtc } from "../../src/lib/zoned-time.js";

const MX = "America/Mexico_City";
const TJ = "America/Tijuana";

function settings(overrides: Partial<CalendarSettings> = {}): CalendarSettings {
  return { slotMinutes: 45, gapMinutes: 15, timezone: MX, minNoticeMinutes: 120, maxAdvanceDays: 60, ...overrides };
}

const hm = (hours: number, minutes = 0): number => hours * 60 + minutes;
// 2026-06-15 es lunes (weekday 1).
const MONDAY = "2026-06-15";
const range = (weekday: number, start: number, end: number): HoursRange => ({ weekday, startMinute: start, endMinute: end });

function localStarts(slots: { startUtc: Date }[], zone = MX): string[] {
  return slots.map((slot) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(slot.startUtc),
  );
}

describe("generateSlotsForDay", () => {
  it("con 45 + 15 los inicios son cada 60 minutos y cada espacio dura 45", () => {
    const slots = generateSlotsForDay(settings(), [range(1, hm(9), hm(14))], MONDAY);
    expect(localStarts(slots)).toEqual(["09:00", "10:00", "11:00", "12:00", "13:00"]);
    expect(slots.every((slot) => slot.endUtc.getTime() - slot.startUtc.getTime() === 45 * 60_000)).toBe(true);
    expect(slots[0]?.startUtc.toISOString()).toBe("2026-06-15T15:00:00.000Z");
  });

  it("el último espacio incompleto no se genera (franja 9:00–10:30 con 45 + 15)", () => {
    const slots = generateSlotsForDay(settings(), [range(1, hm(9), hm(10, 30))], MONDAY);
    expect(localStarts(slots)).toEqual(["09:00"]);
  });

  it("un espacio que termina justo con la franja sí cabe (9:00–9:45)", () => {
    expect(localStarts(generateSlotsForDay(settings(), [range(1, hm(9), hm(9, 45))], MONDAY))).toEqual(["09:00"]);
  });

  it("varias franjas en un día, ordenadas aunque se entreguen desordenadas", () => {
    const slots = generateSlotsForDay(settings(), [range(1, hm(16), hm(18)), range(1, hm(9), hm(11))], MONDAY);
    expect(localStarts(slots)).toEqual(["09:00", "10:00", "16:00", "17:00"]);
  });

  it("solo usa las franjas del día de la semana de la fecha", () => {
    const hours = [range(1, hm(9), hm(10)), range(2, hm(12), hm(13))];
    expect(localStarts(generateSlotsForDay(settings(), hours, MONDAY))).toEqual(["09:00"]);
    expect(localStarts(generateSlotsForDay(settings(), hours, "2026-06-16"))).toEqual(["12:00"]);
  });

  it("un día sin franjas no tiene espacios", () => {
    expect(generateSlotsForDay(settings(), [range(3, hm(9), hm(14))], MONDAY)).toEqual([]);
    expect(generateSlotsForDay(settings(), [], MONDAY)).toEqual([]);
  });

  it("con intervalo 0 los espacios son consecutivos", () => {
    const slots = generateSlotsForDay(settings({ slotMinutes: 30, gapMinutes: 0 }), [range(1, hm(9), hm(11))], MONDAY);
    expect(localStarts(slots)).toEqual(["09:00", "09:30", "10:00", "10:30"]);
  });

  it("la franja que llega a la medianoche (1440) es válida", () => {
    const slots = generateSlotsForDay(settings({ slotMinutes: 60, gapMinutes: 0 }), [range(1, hm(22), 1440)], MONDAY);
    expect(localStarts(slots)).toEqual(["22:00", "23:00"]);
  });

  describe("cambio de hora en America/Tijuana", () => {
    it("salto de primavera (8-mar-2026): no hay espacio en la hora que no existe", () => {
      // Lunes 2026-03-09 no; el domingo 8 es el salto. weekday 7.
      const slots = generateSlotsForDay(settings({ timezone: TJ, slotMinutes: 30, gapMinutes: 0 }), [range(7, hm(1), hm(4))], "2026-03-08");
      expect(localStarts(slots, TJ)).toEqual(["01:00", "01:30", "03:00", "03:30"]);
    });

    it("retroceso de otoño (1-nov-2026): la hora repetida no duplica espacios", () => {
      const slots = generateSlotsForDay(settings({ timezone: TJ, slotMinutes: 60, gapMinutes: 0 }), [range(7, hm(0), hm(3))], "2026-11-01");
      const starts = slots.map((slot) => slot.startUtc.getTime());
      expect(new Set(starts).size).toBe(starts.length);
      expect(starts).toEqual([...starts].sort((a, b) => a - b));
      expect(localStarts(slots, TJ)).toEqual(["00:00", "01:00", "02:00"]);
    });
  });
});

describe("classifySlots", () => {
  const slots = generateSlotsForDay(settings(), [range(1, hm(9), hm(14))], MONDAY);
  const at = (hour: number, minute = 0): Date => localToUtc(MX, MONDAY, hm(hour, minute)) as Date;
  const before = new Date("2026-06-14T12:00:00.000Z"); // el día anterior: nada es pasado

  it("todo libre cuando no hay citas ni bloqueos", () => {
    expect(classifySlots(slots, [], [], before).map((s) => s.state)).toEqual(["free", "free", "free", "free", "free"]);
  });

  it("past si el inicio es igual o anterior a ahora", () => {
    const now = at(10); // justo el inicio del segundo espacio
    expect(classifySlots(slots, [], [], now).map((s) => s.state)).toEqual(["past", "past", "free", "free", "free"]);
  });

  it("booked si una cita vigente coincide con el espacio, y trae su id", () => {
    const result = classifySlots(slots, [{ id: 7, startUtc: at(11), endUtc: at(11, 45) }], [], before);
    expect(result.map((s) => s.state)).toEqual(["free", "free", "booked", "free", "free"]);
    expect(result[2]?.appointmentId).toBe(7);
  });

  it("booked si la cita se solapa con el espacio aunque empiece a otra hora", () => {
    const thirty = generateSlotsForDay(settings({ slotMinutes: 30, gapMinutes: 0 }), [range(1, hm(9), hm(11))], MONDAY);
    // Cita antigua 9:00–9:45: ocupa el espacio de 9:00 y el de 9:30 (se solapa), no el de 10:00.
    const result = classifySlots(thirty, [{ id: 1, startUtc: at(9), endUtc: at(9, 45) }], [], before);
    expect(result.map((s) => s.state)).toEqual(["booked", "booked", "free", "free"]);
  });

  it("una cita que termina justo cuando empieza el espacio no lo ocupa", () => {
    const thirty = generateSlotsForDay(settings({ slotMinutes: 30, gapMinutes: 0 }), [range(1, hm(9), hm(10))], MONDAY);
    const result = classifySlots(thirty, [{ id: 1, startUtc: at(9), endUtc: at(9, 30) }], [], before);
    expect(result.map((s) => s.state)).toEqual(["booked", "free"]);
  });

  it("blocked si un bloqueo se solapa con el espacio", () => {
    const result = classifySlots(slots, [], [{ startUtc: at(10), endUtc: at(12) }], before);
    expect(result.map((s) => s.state)).toEqual(["free", "blocked", "blocked", "free", "free"]);
  });

  it("un bloqueo que solo cubre el intervalo entre espacios no bloquea ninguno", () => {
    // El espacio de 9:00 termina a las 9:45 y el siguiente empieza a las 10:00.
    const result = classifySlots(slots, [], [{ startUtc: at(9, 45), endUtc: at(10) }], before);
    expect(result.map((s) => s.state)).toEqual(["free", "free", "free", "free", "free"]);
  });

  it("booked tiene prioridad sobre blocked (no debería coexistir, pero la cita manda)", () => {
    const result = classifySlots(slots, [{ id: 3, startUtc: at(9), endUtc: at(9, 45) }], [{ startUtc: at(9), endUtc: at(10) }], before);
    expect(result[0]?.state).toBe("booked");
  });

  it("un espacio pasado con cita conserva el id de la cita", () => {
    const result = classifySlots(slots, [{ id: 9, startUtc: at(9), endUtc: at(9, 45) }], [], at(12));
    expect(result[0]).toMatchObject({ state: "past", appointmentId: 9 });
  });
});

describe("findOutOfScheduleAppointments", () => {
  const at = (hour: number, minute = 0): Date => localToUtc(MX, MONDAY, hm(hour, minute)) as Date;
  const slots = generateSlotsForDay(settings(), [range(1, hm(9), hm(12))], MONDAY);

  it("no marca las citas que coinciden exactamente con un espacio", () => {
    expect(findOutOfScheduleAppointments([{ id: 1, startUtc: at(9), endUtc: at(9, 45) }], slots)).toEqual([]);
  });

  it("marca las citas fuera de horario o con otra duración", () => {
    const appointments = [
      { id: 1, startUtc: at(20), endUtc: at(20, 45) }, // fuera de la franja
      { id: 2, startUtc: at(10), endUtc: at(10, 30) }, // mismo inicio, otra duración
      { id: 3, startUtc: at(11), endUtc: at(11, 45) }, // coincide
    ];
    expect(findOutOfScheduleAppointments(appointments, slots).map((a) => a.id)).toEqual([1, 2]);
  });
});
