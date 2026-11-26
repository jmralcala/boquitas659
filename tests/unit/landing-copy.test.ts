import { describe, expect, it } from "vitest";
import { landingPage } from "../../src/http/views/landing.js";

/** Texto visible de la portada en minúsculas y sin acentos (sin cabecera, íconos ni etiquetas). */
function visibleText(): string {
  const html = landingPage({ year: 2026, contactEmail: "soporte@innvend.com" });
  const body = /<body[\s\S]*<\/body>/.exec(html)?.[0] ?? html;
  return body
    .replace(/<svg[\s\S]*?<\/svg>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/g, " ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** Términos que prometerían lo que el piloto no tiene (contracts/page-content.md). */
const FORBIDDEN_SUBSTRINGS = [
  "reprogram", "whatsapp", "mensajer", "rentabil", "ganancia", "ingreso", "precio", "costo", "gratis",
  "descuento", "oferta", "garant", "satisfech", "testimonio", "lider",
];
const FORBIDDEN_WORDS = ["plan", "planes"];

describe("veracidad del texto de la portada (FR-009, SC-003)", () => {
  const text = visibleText();

  it.each(FORBIDDEN_SUBSTRINGS)("no aparece «%s»", (term) => {
    expect(text).not.toContain(term);
  });

  it.each(FORBIDDEN_WORDS)("no aparece la palabra completa «%s» (sí «planear»)", (term) => {
    expect(new RegExp(`\\b${term}\\b`).test(text)).toBe(false);
    expect(text).toContain("planear");
  });

  it("no promete resultados con porcentajes ni cifras de mejora", () => {
    expect(text).not.toContain("%");
    expect(text).not.toMatch(/\d+\s*(x|veces)/);
  });

  it("no menciona las urgencias en línea (dependen de la validación de un dentista)", () => {
    expect(text).not.toContain("urgencia");
  });

  it("incluye las capacidades que el piloto sí ofrece", () => {
    for (const phrase of [
      "reservar y cancelar sus citas en linea",
      "avisos por correo",
      "los horarios, la duracion de cita y los bloqueos que tu eliges",
      "sin dobles reservas",
      "recordatorios por correo",
      "separados de los de otros consultorios",
      "revisamos cada solicitud antes de activar la cuenta",
    ]) {
      expect(text, phrase).toContain(phrase);
    }
  });

  it("el HTML completo pesa menos de 30 KB", () => {
    expect(Buffer.byteLength(landingPage({ year: 2026, contactEmail: "soporte@innvend.com" }))).toBeLessThan(30 * 1024);
  });
});
