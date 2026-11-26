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
    const allowed = /https:\/\/www\.google\.com\/maps\/search\//;
    const external = /https?:\/\/(?!localhost)[a-z0-9.-]+/gi;
    const offenders: string[] = [];
    for (const file of [join(ASSETS, "styles.css"), ...htmlSources.filter((f) => /views|layout|shell|-routes\.ts$/.test(f))]) {
      const text = readFileSync(file, "utf8").replace(allowed, "");
      // Se ignoran comentarios de código y el ejemplo de dominio propio de los textos legales.
      const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const match of withoutComments.matchAll(external)) {
        if (/example\.|innvend\.com|w3\.org/.test(match[0])) continue;
        // Única excepción deliberada: el CAPTCHA de Turnstile del formulario de urgencia (feature 4, constitución IV).
        if (match[0] === "https://challenges.cloudflare.com" && file.endsWith(join("views", "urgent.ts"))) continue;
        offenders.push(`${relative(ROOT, file)}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
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
