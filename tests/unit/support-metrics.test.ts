import { describe, expect, it } from "vitest";
import { dateKey, meets, percent, periodRange, TARGETS, weekStart } from "../../src/modules/support/metrics-service.js";

const NOW = new Date("2026-11-25T15:30:00.000Z"); // miércoles

describe("porcentajes y metas", () => {
  it("un porcentaje sin datos es nulo, no cero", () => {
    expect(percent(0, 0)).toBeNull();
    expect(percent(5, 0)).toBeNull();
    expect(percent(0, 10)).toBe(0);
  });

  it("redondea a un decimal", () => {
    expect(percent(1, 3)).toBe(33.3);
    expect(percent(2, 3)).toBe(66.7);
    expect(percent(7, 10)).toBe(70);
  });

  it("«más de» y «menos de» son estrictos, «al menos» incluye el valor y sin datos no hay veredicto", () => {
    expect(meets(70, TARGETS.completionPercent, "above")).toBe(false);
    expect(meets(70.1, TARGETS.completionPercent, "above")).toBe(true);
    expect(meets(120, TARGETS.bookingSeconds, "below")).toBe(false);
    expect(meets(119, TARGETS.bookingSeconds, "below")).toBe(true);
    expect(meets(98, TARGETS.deliveredPercent, "above")).toBe(false);
    expect(meets(50, TARGETS.sustainedUsePercent, "atLeast")).toBe(true);
    expect(meets(49.9, TARGETS.sustainedUsePercent, "atLeast")).toBe(false);
    expect(meets(null, 70, "above")).toBeNull();
  });

  it("las metas son las de las decisiones del proyecto", () => {
    expect(TARGETS).toEqual({ completionPercent: 70, bookingSeconds: 120, deliveredPercent: 98, sustainedUsePercent: 50 });
  });
});

describe("semanas y periodos", () => {
  it("la semana empieza el lunes a las 00:00 UTC", () => {
    expect(dateKey(weekStart(NOW))).toBe("2026-11-23");
    expect(dateKey(weekStart(new Date("2026-11-29T23:59:59.000Z")))).toBe("2026-11-23"); // domingo
    expect(dateKey(weekStart(new Date("2026-11-30T00:00:00.000Z")))).toBe("2026-11-30"); // lunes
  });

  it("última semana y últimas 4 semanas son 7 y 28 días hacia atrás", () => {
    expect(periodRange("semana", NOW, null).from.toISOString()).toBe("2026-11-18T15:30:00.000Z");
    expect(periodRange("4semanas", NOW, null).from.toISOString()).toBe("2026-10-28T15:30:00.000Z");
    expect(periodRange("semana", NOW, null).to).toEqual(NOW);
  });

  it("todo el piloto arranca en la primera aprobación; sin aprobaciones usa 28 días", () => {
    const start = new Date("2026-11-01T10:00:00.000Z");
    expect(periodRange("piloto", NOW, start).from).toEqual(start);
    expect(periodRange("piloto", NOW, null).from.toISOString()).toBe("2026-10-28T15:30:00.000Z");
  });
});
