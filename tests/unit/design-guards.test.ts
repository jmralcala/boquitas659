import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const SRC = join(ROOT, "src");
const ASSETS = join(SRC, "http", "assets");

function filesUnder(directory: string, extension: RegExp): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path, extension));
    else if (extension.test(entry.name)) out.push(path);
  }
  return out;
}

const styles = readFileSync(join(ASSETS, "styles.css"), "utf8");
/** La hoja sin el bloque `:root`, donde viven todos los colores. */
const stylesOutsideRoot = styles.replace(/:root\s*\{[^}]*\}/, "");

/** Código que genera HTML: vistas y rutas con HTML en línea. Excluye pruebas y los recursos estáticos. */
const htmlSources = filesUnder(SRC, /\.ts$/).filter((file) => !file.includes(`${join("http", "assets")}`));


/**
 * Direcciones externas que una vista o la hoja no debería contener. Excepciones deliberadas: los ejemplos de dominio propio
 * de los textos legales (`example.`), el espacio de nombres SVG, los mapas («Cómo llegar»), el CAPTCHA de Turnstile del
 * formulario de urgencia (feature 4) y, desde la feature 8, **solo** `https://www.innvend.com` en la vista «Nosotros».
 */
function externalOffenders(file: string, source: string): string[] {
  const allowedMaps = /https:\/\/www\.google\.com\/maps\/search\//;
  const external = /https?:\/\/(?!localhost)[a-z0-9.-]+/gi;
  const text = source.replace(allowedMaps, "");
  const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const offenders: string[] = [];
  for (const match of withoutComments.matchAll(external)) {
    if (/example\.|w3\.org/.test(match[0])) continue;
    if (match[0].toLowerCase() === "https://www.innvend.com" && file.endsWith(join("views", "about.ts"))) continue;
    if (match[0] === "https://challenges.cloudflare.com" && file.endsWith(join("views", "urgent.ts"))) continue;
    offenders.push(match[0]);
  }
  return offenders;
}

describe("guardias del sistema visual (FR-002, FR-016, FR-017, SC-005, SC-006)", () => {
  it("la hoja define sus colores solo en :root", () => {
    expect(styles).toMatch(/:root\s*\{/);
    expect(stylesOutsideRoot).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(stylesOutsideRoot).not.toMatch(/\b(?:rgb|rgba|hsl|hsla)\(/i);
  });

  it("ninguna vista ni ruta usa atributos style= (la CSP los bloquearía y rompería la regla de un solo lugar)", () => {
    const offenders = htmlSources.filter((file) => /\sstyle\s*=/.test(readFileSync(file, "utf8"))).map((file) => relative(ROOT, file));
    expect(offenders).toEqual([]);
  });

  it("ni la hoja ni las vistas piden recursos a dominios externos", () => {
    const offenders: string[] = [];
    for (const file of [join(ASSETS, "styles.css"), ...htmlSources.filter((f) => /views|layout|shell|-routes.ts$/.test(f))]) {
      offenders.push(...externalOffenders(file, readFileSync(file, "utf8")).map((match) => `${relative(ROOT, file)}: ${match}`));
    }
    expect(offenders).toEqual([]);
  });

  it("la excepción de innvend.com está acotada a https://www.innvend.com en la vista «Nosotros» (feature 8)", () => {
    const about = join("views", "about.ts");
    expect(externalOffenders(about, 'enlace a "https://www.innvend.com"')).toEqual([]);
    // En cualquier otro archivo el mismo enlace falla, y cualquier otro dominio parecido falla también.
    expect(externalOffenders(join("views", "landing.ts"), 'enlace a "https://www.innvend.com"')).toEqual(["https://www.innvend.com"]);
    expect(externalOffenders(about, 'enlace a "https://otro-innvend.com"')).toEqual(["https://otro-innvend.com"]);
    expect(externalOffenders(about, 'enlace a "https://innvend.com.malo.net"')).toEqual(["https://innvend.com.malo.net"]);
    expect(externalOffenders(about, 'imagen "https://cdn.example.org/x.png"')).toEqual([]);
  });

  it("la hoja y las fuentes pesan menos de 300 KB en total", () => {
    const files = [join(ASSETS, "styles.css"), ...filesUnder(join(ASSETS, "fonts"), /\.woff2$/)];
    const total = files.reduce((sum, file) => sum + statSync(file).size, 0);
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(total).toBeLessThan(300 * 1024);
  });

  it("las fuentes incluyen su licencia", () => {
    const licenses = readFileSync(join(ASSETS, "fonts", "LICENSES.md"), "utf8");
    expect(licenses).toContain("SIL Open Font License");
    expect(licenses).toContain("Inter");
    expect(licenses).toContain("Manrope");
  });
});
