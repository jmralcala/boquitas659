import { describe, expect, it } from "vitest";
import { aboutPage } from "../../src/http/views/about.js";
import { howItWorksPage } from "../../src/http/views/how-it-works.js";
import { plansPage } from "../../src/http/views/plans.js";

const OPTIONS = { year: 2026, contactEmail: "soporte@innvend.com" };

/** Texto visible en minúsculas y sin acentos: sin barra superior (el menú lleva «Planes»), íconos ni etiquetas. */
function visibleText(html: string): string {
  const body = /<body[\s\S]*<\/body>/.exec(html)?.[0] ?? html;
  const title = /<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? "";
  const description = /<meta name="description" content="([^"]*)">/.exec(html)?.[1] ?? "";
  return `${body.replace(/<header[\s\S]*?<\/header>/, "")} ${title} ${description}`
    .replace(/<svg[\s\S]*?<\/svg>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/g, " ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** Términos prohibidos en todas las páginas informativas (contracts/page-content.md). */
const ALL_PAGES = ["reprogram", "rentabil", "ganancia", "ingreso", "garant", "satisfech", "testimonio", "lider", "#1", "mensajer", "pasarela", "openpay", "1 peso", "excedent", "exceso"];
/** Además, en «Cómo funciona» y «Nosotros» (WhatsApp, precios y descuentos solo viven en «Planes»). */
const HOW_AND_ABOUT = ["whatsapp", "precio", "costo", "gratis", "descuento", "oferta", "urgencia", "%"];

describe("veracidad de «Cómo funciona» (FR-009)", () => {
  const text = visibleText(howItWorksPage(OPTIONS));

  it.each([...ALL_PAGES, ...HOW_AND_ABOUT])("no aparece «%s»", (term) => {
    expect(text).not.toContain(term);
  });

  it("incluye las capacidades que el piloto sí ofrece", () => {
    for (const phrase of [
      "micrositio",
      "sin dobles reservas",
      "correo de confirmacion",
      "personal de recepcion",
      "separados de los de otros consultorios",
      "registro nacional de profesionistas",
      "cancelacion del paciente hasta 24 horas antes",
      "comunidad de odontologos en mexico",
    ]) {
      expect(text, phrase).toContain(phrase);
    }
  });
});

describe("veracidad de «Planes» (FR-009, FR-012 a FR-014)", () => {
  const html = plansPage(OPTIONS);
  const text = visibleText(html);

  it.each(ALL_PAGES)("no aparece «%s»", (term) => {
    expect(text).not.toContain(term);
  });

  it.each(["gratis", "oferta"])("no aparece «%s»", (term) => {
    expect(text).not.toContain(term);
  });

  it("WhatsApp solo aparece junto a «Próximamente»", () => {
    const blocks = html.match(/<li>[\s\S]*?<\/li>/g) ?? [];
    const mentions = blocks.filter((block) => /whatsapp/i.test(block));
    expect(mentions.length).toBeGreaterThanOrEqual(4);
    for (const block of mentions) expect(block.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(), block).toContain("proximamente");
  });

  it("el único porcentaje es «30 %»", () => {
    for (const match of text.matchAll(/(.{0,4})%/g)) expect(match[1]).toMatch(/30 $/);
  });

  it("deja claras la promoción de lanzamiento y la ausencia de cobro durante el piloto", () => {
    expect(text).toContain("promocion de lanzamiento por tiempo limitado");
    expect(text).toContain("sujetos a cambio");
    expect(text).toContain("durante el piloto no se realiza ningun cobro");
    expect(text).toContain("el cobro se activara mas adelante");
    expect(text).toContain("hoy los avisos de agenda dental salen por correo");
  });
});

describe("veracidad de «Nosotros» (FR-017 a FR-019)", () => {
  const text = visibleText(aboutPage(OPTIONS));

  it.each([...ALL_PAGES, ...HOW_AND_ABOUT])("no aparece «%s»", (term) => {
    expect(text).not.toContain(term);
  });

  it.each(["direccion", "facebook", "linkedin", "instagram", "twitter", "x.com"])("no inventa datos que el sitio de Innvend no muestra: «%s»", (term) => {
    expect(text).not.toContain(term);
  });

  it("dice lo que el sitio de Innvend afirma", () => {
    for (const phrase of ["producto desarrollado por innvend works", "software, datos e ia para empresas", "mas de 20 anos de experiencia", "contacto@innvend.com", "(52) 33 1241 5547"]) {
      expect(text, phrase).toContain(phrase);
    }
  });
});
