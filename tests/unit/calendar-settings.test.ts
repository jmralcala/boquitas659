import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/http/errors.js";
import { parseCalendarForm } from "../../src/modules/calendar/settings.js";

/** Cuerpo de formulario válido: 45/15, México, 2 h, 60 días y lunes de 9 a 14. */
function validBody(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    slotMinutes: "45",
    gapMinutes: "15",
    timezone: "America/Mexico_City",
    minNoticeHours: "2",
    maxAdvanceDays: "60",
    h1_0_start: "09:00",
    h1_0_end: "14:00",
    ...overrides,
  };
}

function fieldsOf(body: Record<string, unknown>): Record<string, readonly string[]> {
  try {
    parseCalendarForm(body);
  } catch (error) {
    if (error instanceof ValidationError) return error.fields ?? {};
    throw error;
  }
  throw new Error("Se esperaba un ValidationError.");
}

describe("parseCalendarForm: valores válidos", () => {
  it("acepta los valores por defecto y convierte horas a minutos", () => {
    const result = parseCalendarForm(validBody());
    expect(result.settings).toEqual({ slotMinutes: 45, gapMinutes: 15, timezone: "America/Mexico_City", minNoticeMinutes: 120, maxAdvanceDays: 60 });
    expect(result.hours).toEqual([{ weekday: 1, startMinute: 540, endMinute: 840 }]);
  });

  it("acepta varias franjas por día y días distintos, ordenadas", () => {
    const result = parseCalendarForm(
      validBody({ h1_1_start: "16:00", h1_1_end: "19:00", h3_0_start: "10:00", h3_0_end: "12:30", h7_0_start: "08:00", h7_0_end: "09:00" }),
    );
    expect(result.hours).toEqual([
      { weekday: 1, startMinute: 540, endMinute: 840 },
      { weekday: 1, startMinute: 960, endMinute: 1140 },
      { weekday: 3, startMinute: 600, endMinute: 750 },
      { weekday: 7, startMinute: 480, endMinute: 540 },
    ]);
  });

  it("ignora las franjas con inicio y fin vacíos y acepta un horario sin ninguna franja", () => {
    const body = validBody({ h1_0_start: "", h1_0_end: "", h2_0_start: "", h2_0_end: "" });
    expect(parseCalendarForm(body).hours).toEqual([]);
  });

  it("acepta franjas adyacentes y que terminen a las 24:00", () => {
    const result = parseCalendarForm(validBody({ h1_0_start: "09:00", h1_0_end: "12:00", h1_1_start: "12:00", h1_1_end: "24:00" }));
    expect(result.hours).toEqual([
      { weekday: 1, startMinute: 540, endMinute: 720 },
      { weekday: 1, startMinute: 720, endMinute: 1440 },
    ]);
  });

  it("acepta los límites: duración 15 y 180, intervalo 0 y 60, mínima 0 h y 168 h, máxima 1 y 365 días", () => {
    expect(() => parseCalendarForm(validBody({ slotMinutes: "15", gapMinutes: "0" }))).not.toThrow();
    expect(() => parseCalendarForm(validBody({ slotMinutes: "180", gapMinutes: "60" }))).not.toThrow();
    expect(() => parseCalendarForm(validBody({ minNoticeHours: "0", maxAdvanceDays: "1" }))).not.toThrow();
    expect(() => parseCalendarForm(validBody({ minNoticeHours: "168", maxAdvanceDays: "365" }))).not.toThrow();
  });

  it("acepta todas las zonas de México de la lista", () => {
    for (const zone of ["America/Tijuana", "America/Cancun", "America/Hermosillo"]) {
      expect(parseCalendarForm(validBody({ timezone: zone })).settings.timezone).toBe(zone);
    }
  });
});

describe("parseCalendarForm: valores inválidos (un mensaje por campo)", () => {
  it.each([["0"], ["14"], ["17"], ["181"], ["-45"], ["abc"], ["45.5"]])("rechaza la duración %s", (value) => {
    expect(fieldsOf(validBody({ slotMinutes: value })).slotMinutes?.length).toBeGreaterThan(0);
  });

  it.each([["7"], ["61"], ["65"], ["-5"], ["x"]])("rechaza el intervalo %s", (value) => {
    expect(fieldsOf(validBody({ gapMinutes: value })).gapMinutes?.length).toBeGreaterThan(0);
  });

  it.each([["1e1"], ["0x10"], [" 4 5"], ["+45"], ["45,0"], ["４５"]])("rechaza la duración con formato raro %s", (value) => {
    expect(fieldsOf(validBody({ slotMinutes: value })).slotMinutes?.length).toBeGreaterThan(0);
  });

  it("acepta espacios alrededor de un número válido", () => {
    expect(parseCalendarForm(validBody({ slotMinutes: " 45 " })).settings.slotMinutes).toBe(45);
  });

  it("rechaza una zona fuera de la lista o inexistente", () => {
    expect(fieldsOf(validBody({ timezone: "Europe/Madrid" })).timezone).toBeDefined();
    expect(fieldsOf(validBody({ timezone: "No/Existe" })).timezone).toBeDefined();
    expect(fieldsOf(validBody({ timezone: "" })).timezone).toBeDefined();
  });

  it.each([["0"], ["366"], ["-1"], ["abc"]])("rechaza la anticipación máxima %s", (value) => {
    expect(fieldsOf(validBody({ maxAdvanceDays: value })).maxAdvanceDays?.length).toBeGreaterThan(0);
  });

  it.each([["-1"], ["169"], ["1.5"], ["abc"]])("rechaza la anticipación mínima %s", (value) => {
    expect(fieldsOf(validBody({ minNoticeHours: value })).minNoticeHours?.length).toBeGreaterThan(0);
  });

  it("rechaza una mínima igual o mayor que la máxima", () => {
    expect(fieldsOf(validBody({ minNoticeHours: "24", maxAdvanceDays: "1" })).minNoticeHours).toBeDefined();
    expect(fieldsOf(validBody({ minNoticeHours: "48", maxAdvanceDays: "1" })).minNoticeHours).toBeDefined();
    expect(() => parseCalendarForm(validBody({ minNoticeHours: "23", maxAdvanceDays: "1" }))).not.toThrow();
  });

  it("rechaza una franja con el fin antes o igual que el inicio", () => {
    expect(fieldsOf(validBody({ h1_0_start: "14:00", h1_0_end: "09:00" })).h1_0).toBeDefined();
    expect(fieldsOf(validBody({ h1_0_start: "09:00", h1_0_end: "09:00" })).h1_0).toBeDefined();
  });

  it("rechaza franjas solapadas en un mismo día", () => {
    const fields = fieldsOf(validBody({ h1_1_start: "13:00", h1_1_end: "15:00" }));
    expect(Object.keys(fields).some((key) => key.startsWith("h1"))).toBe(true);
  });

  it("rechaza una franja a medias (solo inicio o solo fin)", () => {
    expect(fieldsOf(validBody({ h2_0_start: "09:00", h2_0_end: "" })).h2_0).toBeDefined();
    expect(fieldsOf(validBody({ h2_0_start: "", h2_0_end: "10:00" })).h2_0).toBeDefined();
  });

  it("rechaza minutos que no son múltiplos de 5 y horas mal formadas", () => {
    expect(fieldsOf(validBody({ h1_0_start: "09:03" })).h1_0).toBeDefined();
    expect(fieldsOf(validBody({ h1_0_end: "14:07" })).h1_0).toBeDefined();
    expect(fieldsOf(validBody({ h1_0_start: "9am" })).h1_0).toBeDefined();
    expect(fieldsOf(validBody({ h1_0_start: "25:00" })).h1_0).toBeDefined();
    expect(fieldsOf(validBody({ h1_0_start: "09:60" })).h1_0).toBeDefined();
  });

  it("24:00 solo vale como fin, nunca como inicio", () => {
    expect(fieldsOf(validBody({ h1_0_start: "24:00", h1_0_end: "24:00" })).h1_0).toBeDefined();
    expect(() => parseCalendarForm(validBody({ h1_0_start: "20:00", h1_0_end: "24:00" }))).not.toThrow();
  });

  it("ignora los campos desconocidos y no admite una quinta franja", () => {
    const body = validBody({ h1_4_start: "20:00", h1_4_end: "21:00", inventado: "x" });
    expect(parseCalendarForm(body).hours).toEqual([{ weekday: 1, startMinute: 540, endMinute: 840 }]);
  });

  it("entrega un error por cada campo inválido a la vez", () => {
    const fields = fieldsOf(validBody({ slotMinutes: "0", gapMinutes: "7", timezone: "x" }));
    expect(Object.keys(fields).sort()).toEqual(["gapMinutes", "slotMinutes", "timezone"]);
  });

  it("nunca incluye los valores recibidos en los mensajes", () => {
    const fields = fieldsOf(validBody({ slotMinutes: "123456789", timezone: "secreto-xyz" }));
    expect(JSON.stringify(fields)).not.toContain("123456789");
    expect(JSON.stringify(fields)).not.toContain("secreto-xyz");
  });
});
