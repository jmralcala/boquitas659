import { describe, expect, it } from "vitest";
import {
  ALLOWED_TIMEZONES,
  addLocalDays,
  isAllowedTimezone,
  isValidLocalDate,
  localDayRangeUtc,
  localToUtc,
  utcToLocal,
} from "../../src/lib/zoned-time.js";

const MX = "America/Mexico_City"; // UTC−6 todo el año desde 2022
const TJ = "America/Tijuana"; // sigue el horario de verano de EE. UU.

describe("zonas permitidas", () => {
  it("incluye Ciudad de México y solo zonas de México", () => {
    expect(ALLOWED_TIMEZONES).toContain("America/Mexico_City");
    expect(ALLOWED_TIMEZONES.every((zone) => zone.startsWith("America/"))).toBe(true);
    expect(ALLOWED_TIMEZONES).toHaveLength(12);
  });

  it("acepta las zonas de la lista y rechaza el resto", () => {
    expect(isAllowedTimezone(TJ)).toBe(true);
    expect(isAllowedTimezone("Europe/Madrid")).toBe(false);
    expect(isAllowedTimezone("America/New_York")).toBe(false);
    expect(isAllowedTimezone("Mexico/General")).toBe(false);
    expect(isAllowedTimezone("")).toBe(false);
    expect(isAllowedTimezone("no-existe")).toBe(false);
  });
});

describe("fechas locales", () => {
  it("valida el formato y la existencia del día", () => {
    expect(isValidLocalDate("2026-02-28")).toBe(true);
    expect(isValidLocalDate("2028-02-29")).toBe(true);
    expect(isValidLocalDate("2026-02-30")).toBe(false);
    expect(isValidLocalDate("2026-13-01")).toBe(false);
    expect(isValidLocalDate("2026-1-1")).toBe(false);
    expect(isValidLocalDate("hoy")).toBe(false);
  });

  it("suma días de calendario, también a través de meses, años y cambios de hora", () => {
    expect(addLocalDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addLocalDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addLocalDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addLocalDays("2026-03-07", 2)).toBe("2026-03-09"); // el 8 de marzo cambia la hora en Tijuana
    expect(addLocalDays("2026-10-31", 2)).toBe("2026-11-02");
  });
});

describe("local → UTC", () => {
  it("Ciudad de México (UTC−6, sin horario de verano)", () => {
    expect(localToUtc(MX, "2026-06-15", 9 * 60)?.toISOString()).toBe("2026-06-15T15:00:00.000Z");
    expect(localToUtc(MX, "2026-01-15", 9 * 60)?.toISOString()).toBe("2026-01-15T15:00:00.000Z");
  });

  it("Tijuana usa UTC−8 en invierno y UTC−7 en verano", () => {
    expect(localToUtc(TJ, "2026-01-15", 9 * 60)?.toISOString()).toBe("2026-01-15T17:00:00.000Z");
    expect(localToUtc(TJ, "2026-07-15", 9 * 60)?.toISOString()).toBe("2026-07-15T16:00:00.000Z");
  });

  it("una hora local que no existe (salto de primavera) devuelve null", () => {
    expect(localToUtc(TJ, "2026-03-08", 2 * 60 + 30)).toBeNull();
    expect(localToUtc(TJ, "2026-03-08", 2 * 60)).toBeNull();
    // Justo antes y justo después del salto sí existen.
    expect(localToUtc(TJ, "2026-03-08", 1 * 60 + 55)?.toISOString()).toBe("2026-03-08T09:55:00.000Z");
    expect(localToUtc(TJ, "2026-03-08", 3 * 60)?.toISOString()).toBe("2026-03-08T10:00:00.000Z");
  });

  it("una hora local repetida (retroceso de otoño) devuelve la primera ocurrencia", () => {
    // 1 de noviembre de 2026: la 1:30 ocurre en UTC−7 (08:30Z) y otra vez en UTC−8 (09:30Z).
    expect(localToUtc(TJ, "2026-11-01", 1 * 60 + 30)?.toISOString()).toBe("2026-11-01T08:30:00.000Z");
  });

  it("1440 minutos es la medianoche del día siguiente", () => {
    expect(localToUtc(MX, "2026-06-15", 1440)?.toISOString()).toBe("2026-06-16T06:00:00.000Z");
  });

  it("rechaza fechas inexistentes y minutos fuera de rango", () => {
    expect(localToUtc(MX, "2026-02-30", 600)).toBeNull();
    expect(localToUtc(MX, "2026-02-10", -5)).toBeNull();
    expect(localToUtc(MX, "2026-02-10", 1441)).toBeNull();
  });
});

describe("UTC → local", () => {
  it("devuelve fecha, minutos del día y día de la semana (lunes = 1)", () => {
    // 2026-06-15 es lunes.
    expect(utcToLocal(MX, new Date("2026-06-15T15:00:00.000Z"))).toEqual({ date: "2026-06-15", minutesOfDay: 540, weekday: 1 });
    // El domingo cuenta como 7.
    expect(utcToLocal(MX, new Date("2026-06-21T15:00:00.000Z")).weekday).toBe(7);
  });

  it("un instante cercano a la medianoche UTC cae en el día local anterior", () => {
    expect(utcToLocal(MX, new Date("2026-06-16T03:30:00.000Z"))).toEqual({ date: "2026-06-15", minutesOfDay: 21 * 60 + 30, weekday: 1 });
    expect(utcToLocal(TJ, new Date("2026-06-16T06:59:00.000Z")).date).toBe("2026-06-15");
    expect(utcToLocal(TJ, new Date("2026-06-16T07:00:00.000Z")).date).toBe("2026-06-16");
  });

  it("es la inversa de local → UTC fuera de los cambios de hora", () => {
    const utc = localToUtc(TJ, "2026-05-20", 17 * 60 + 45);
    expect(utc).not.toBeNull();
    expect(utcToLocal(TJ, utc as Date)).toMatchObject({ date: "2026-05-20", minutesOfDay: 17 * 60 + 45 });
  });
});

describe("rango UTC de un día local", () => {
  it("un día normal dura 24 horas", () => {
    const { start, end } = localDayRangeUtc(MX, "2026-06-15");
    expect(start.toISOString()).toBe("2026-06-15T06:00:00.000Z");
    expect(end.toISOString()).toBe("2026-06-16T06:00:00.000Z");
  });

  it("el día del salto de primavera dura 23 horas y el del retroceso 25", () => {
    const spring = localDayRangeUtc(TJ, "2026-03-08");
    expect((spring.end.getTime() - spring.start.getTime()) / 3_600_000).toBe(23);
    const fall = localDayRangeUtc(TJ, "2026-11-01");
    expect((fall.end.getTime() - fall.start.getTime()) / 3_600_000).toBe(25);
  });

  it("los días consecutivos no se solapan ni dejan huecos", () => {
    const a = localDayRangeUtc(TJ, "2026-03-08");
    const b = localDayRangeUtc(TJ, "2026-03-09");
    expect(a.end.getTime()).toBe(b.start.getTime());
  });
});
