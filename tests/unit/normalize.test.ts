import { describe, expect, it } from "vitest";
import { normalizeCedula, normalizeEmail, normalizeMxPhone } from "../../src/lib/normalize.js";

describe("normalizeEmail", () => {
  it("pasa a minúsculas y quita espacios", () => {
    expect(normalizeEmail("  Ana.Perez@Example.COM ")).toBe("ana.perez@example.com");
  });

  it("rechaza formatos inválidos", () => {
    expect(normalizeEmail("sin-arroba")).toBeNull();
    expect(normalizeEmail("a@b")).toBeNull();
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail("dos@@example.com")).toBeNull();
  });
});

describe("normalizeMxPhone", () => {
  it("acepta 10 dígitos con separadores", () => {
    expect(normalizeMxPhone("55 1234 5678")).toBe("5512345678");
    expect(normalizeMxPhone("(55) 1234-5678")).toBe("5512345678");
    expect(normalizeMxPhone("55.1234.5678")).toBe("5512345678");
  });

  it("acepta el prefijo de país +52 y el formato antiguo +521", () => {
    expect(normalizeMxPhone("+52 55 1234 5678")).toBe("5512345678");
    expect(normalizeMxPhone("+521 55 1234 5678")).toBe("5512345678");
    expect(normalizeMxPhone("0052 55 1234 5678")).toBe("5512345678");
  });

  it("rechaza longitudes y caracteres inválidos", () => {
    expect(normalizeMxPhone("123456789")).toBeNull();
    expect(normalizeMxPhone("55123456789")).toBeNull();
    expect(normalizeMxPhone("55-abcd-5678")).toBeNull();
    expect(normalizeMxPhone("")).toBeNull();
  });

  it("rechaza lada que empieza con 0 o 1", () => {
    expect(normalizeMxPhone("0512345678")).toBeNull();
    expect(normalizeMxPhone("1512345678")).toBeNull();
  });
});

describe("normalizeCedula", () => {
  it("deja solo dígitos de 7 u 8 caracteres", () => {
    expect(normalizeCedula(" 1234567 ")).toBe("1234567");
    expect(normalizeCedula("1234-5678")).toBe("12345678");
  });

  it("rechaza letras y longitudes fuera de rango", () => {
    expect(normalizeCedula("12345")).toBeNull();
    expect(normalizeCedula("123456789")).toBeNull();
    expect(normalizeCedula("12A45678")).toBeNull();
    expect(normalizeCedula("")).toBeNull();
  });
});
