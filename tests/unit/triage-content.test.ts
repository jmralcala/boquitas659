import { describe, expect, it } from "vitest";
import {
  ALARM_SIGNAL_IDS,
  CATEGORY_IDS,
  TRIAGE_CONTENT,
  categoryById,
  parseAlarmSignals,
  parseCategory,
  urgentContentAvailable,
} from "../../src/modules/urgent/triage-content.js";

describe("contenido del triaje", () => {
  it("hay exactamente 5 categorías en orden de gravedad con sus ventanas provisionales", () => {
    expect([...CATEGORY_IDS]).toEqual(["rojo", "naranja", "amarillo", "verde_claro", "verde"]);
    expect(TRIAGE_CONTENT.categories.map((category) => category.id)).toEqual([...CATEGORY_IDS]);
    expect(TRIAGE_CONTENT.categories.map((category) => category.windowHours)).toEqual([2, 12, 24, 48, 72]);
  });

  it("hay exactamente 2 señales de alarma", () => {
    expect([...ALARM_SIGNAL_IDS]).toEqual(["dificultad_respirar_tragar", "hinchazon_ojo"]);
    expect(TRIAGE_CONTENT.alarmSignals.map((signal) => signal.id)).toEqual([...ALARM_SIGNAL_IDS]);
  });

  it("es provisional y está versionado", () => {
    expect(TRIAGE_CONTENT.reviewedByDentist).toBe(false);
    expect(TRIAGE_CONTENT.version.length).toBeGreaterThan(0);
  });

  it("los textos no están vacíos y los niveles altos exigen el aviso de hospital", () => {
    for (const category of TRIAGE_CONTENT.categories) {
      expect(category.label.trim()).not.toBe("");
      expect(category.optionText.trim()).not.toBe("");
      expect([1, 2, 3, 4, 5]).toContain(category.tone);
    }
    for (const signal of TRIAGE_CONTENT.alarmSignals) expect(signal.label.trim()).not.toBe("");
    expect(TRIAGE_CONTENT.hospitalNotice.trim()).not.toBe("");
    expect(TRIAGE_CONTENT.alarmNotice.trim()).not.toBe("");
    expect(TRIAGE_CONTENT.firstAid.length).toBeGreaterThan(0);
    expect(categoryById("rojo").requiresHospitalNotice).toBe(true);
    expect(categoryById("verde").requiresHospitalNotice).toBe(false);
  });

  it("ningún texto contiene datos personales (correos, teléfonos ni enlaces)", () => {
    const all = JSON.stringify(TRIAGE_CONTENT);
    expect(all).not.toMatch(/@|https?:\/\/|\d{10}/);
  });
});

describe("parseCategory", () => {
  it("acepta solo las 5 categorías", () => {
    for (const id of CATEGORY_IDS) expect(parseCategory(id)).toBe(id);
    for (const invalid of ["", "ROJO", "rojo ", "azul", "1", null, undefined, 3, {}, ["rojo"]]) expect(parseCategory(invalid)).toBeNull();
  });
});

describe("parseAlarmSignals", () => {
  it("sin señales devuelve una lista vacía y acepta una, varias o repetidas", () => {
    expect(parseAlarmSignals(undefined)).toEqual([]);
    expect(parseAlarmSignals("")).toEqual([]);
    expect(parseAlarmSignals([])).toEqual([]);
    expect(parseAlarmSignals("hinchazon_ojo")).toEqual(["hinchazon_ojo"]);
    expect(parseAlarmSignals(["dificultad_respirar_tragar", "hinchazon_ojo", "hinchazon_ojo"])).toEqual(["dificultad_respirar_tragar", "hinchazon_ojo"]);
  });

  it("rechaza cualquier valor desconocido (devuelve null)", () => {
    for (const invalid of ["otra", ["hinchazon_ojo", "otra"], 1, {}, [1]]) expect(parseAlarmSignals(invalid)).toBeNull();
  });
});

describe("urgentContentAvailable", () => {
  it("en desarrollo siempre está disponible; en producción solo si un dentista lo revisó", () => {
    expect(urgentContentAvailable("development")).toBe(true);
    expect(urgentContentAvailable("production")).toBe(false);
    expect(urgentContentAvailable("production", { ...TRIAGE_CONTENT, reviewedByDentist: true })).toBe(true);
  });
});
