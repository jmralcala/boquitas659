import { describe, expect, it } from "vitest";
import { calculateAge, parseBirthDate, todayInZone } from "../../src/lib/age.js";

describe("calculateAge", () => {
  it("cuenta años cumplidos, no años de calendario", () => {
    expect(calculateAge("2020-06-15", "2026-06-14")).toBe(5);
    expect(calculateAge("2020-06-15", "2026-06-15")).toBe(6);
    expect(calculateAge("2020-06-15", "2026-06-16")).toBe(6);
    expect(calculateAge("1990-12-31", "2026-01-01")).toBe(35);
  });

  it("trata el 29 de febrero: en años no bisiestos cumple el 1 de marzo", () => {
    expect(calculateAge("2000-02-29", "2026-02-28")).toBe(25);
    expect(calculateAge("2000-02-29", "2026-03-01")).toBe(26);
    expect(calculateAge("2000-02-29", "2028-02-28")).toBe(27);
    expect(calculateAge("2000-02-29", "2028-02-29")).toBe(28);
  });

  it("devuelve 0 para un recién nacido y rechaza fechas futuras", () => {
    expect(calculateAge("2026-06-15", "2026-06-15")).toBe(0);
    expect(calculateAge("2026-06-14", "2026-06-15")).toBe(0);
    expect(() => calculateAge("2026-06-16", "2026-06-15")).toThrow();
  });
});

describe("parseBirthDate", () => {
  const today = "2026-06-15";

  it("acepta fechas reales del pasado en formato AAAA-MM-DD", () => {
    expect(parseBirthDate("1990-05-17", today)).toBe("1990-05-17");
    expect(parseBirthDate("2000-02-29", today)).toBe("2000-02-29");
    expect(parseBirthDate("2026-06-15", today)).toBe("2026-06-15");
  });

  it("rechaza fechas inexistentes, futuras, absurdas o mal formateadas", () => {
    expect(parseBirthDate("2026-02-30", today)).toBeNull();
    expect(parseBirthDate("2001-02-29", today)).toBeNull();
    expect(parseBirthDate("1990-13-01", today)).toBeNull();
    expect(parseBirthDate("2026-06-16", today)).toBeNull();
    expect(parseBirthDate("1890-01-01", today)).toBeNull();
    expect(parseBirthDate("1990-5-1", today)).toBeNull();
    expect(parseBirthDate("17/05/1990", today)).toBeNull();
    expect(parseBirthDate("", today)).toBeNull();
    expect(parseBirthDate("1990-05-17T00:00:00Z", today)).toBeNull();
  });
});

describe("todayInZone", () => {
  it("usa la fecha de la zona horaria del consultorio, no la de UTC", () => {
    // 02:00 UTC del 16 de junio es todavía el 15 en Ciudad de México (UTC-6).
    expect(todayInZone(new Date("2026-06-16T02:00:00.000Z"), "America/Mexico_City")).toBe("2026-06-15");
    expect(todayInZone(new Date("2026-06-16T07:00:00.000Z"), "America/Mexico_City")).toBe("2026-06-16");
  });
});
