import { describe, expect, it } from "vitest";
import { SLUG_MAX, SLUG_MIN, isValidSlug, slugErrors } from "../../src/lib/site-slug.js";

describe("isValidSlug", () => {
  it.each(["clinica-sonrisa", "a1b", "dr-lopez-2", "123", "abc", "x".repeat(40), "a-b-c-d", "9-9"])("acepta %s", (slug) => {
    expect(isValidSlug(slug)).toBe(true);
  });

  it.each([
    ["", "vacío"],
    ["ab", "2 caracteres"],
    ["x".repeat(41), "41 caracteres"],
    ["Clinica", "mayúscula"],
    ["clínica", "acento"],
    ["mi clinica", "espacio"],
    ["mi_clinica", "guion bajo"],
    ["-abc", "guion al principio"],
    ["abc-", "guion al final"],
    ["a--b", "guiones consecutivos"],
    ["a/b", "barra"],
    ["a.b", "punto"],
    ["a%20b", "porcentaje"],
    ["..", "puntos"],
    [" abc", "espacio al principio"],
    ["abc\n", "salto de línea"],
    ["ñandú", "eñe"],
  ])("rechaza %j (%s)", (slug) => {
    expect(isValidSlug(slug)).toBe(false);
  });

  it("los límites son 3 y 40", () => {
    expect([SLUG_MIN, SLUG_MAX]).toEqual([3, 40]);
  });
});

describe("slugErrors", () => {
  it("no devuelve errores para un nombre válido", () => {
    expect(slugErrors("clinica-sonrisa")).toEqual([]);
  });

  it("explica la longitud y los caracteres permitidos sin repetir el valor recibido", () => {
    const short = slugErrors("ab");
    expect(short.join(" ")).toMatch(/3 y 40/);
    const bad = slugErrors("Mi Clínica!");
    expect(bad.join(" ")).toMatch(/minúsculas/);
    expect(bad.join(" ")).not.toContain("Mi Clínica!");
  });

  it("no acepta un nombre con mayúsculas aunque en minúsculas sería válido", () => {
    expect(isValidSlug("Clinica-Sonrisa")).toBe(false);
    expect(slugErrors("Clinica-Sonrisa").length).toBeGreaterThan(0);
  });

  it("explica guiones al principio, al final o dobles", () => {
    for (const slug of ["-abc", "abc-", "a--b"]) expect(slugErrors(slug).join(" ")).toMatch(/guion/i);
  });
});
