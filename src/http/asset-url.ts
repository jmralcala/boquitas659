import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Recursos estáticos del diseño (hoja de estilos y fuentes propias). Se leen UNA vez al cargar el módulo, relativos al
 * propio archivo: así funciona igual desde `src/` (pruebas y desarrollo) y desde `dist/` (producción, tras `copy-assets`).
 * La lista es cerrada: ningún nombre recibido en una petición se convierte en una ruta de disco.
 */
export interface StaticAsset {
  /** Ruta pública, por ejemplo `/assets/styles.css`. */
  url: string;
  type: string;
  body: Buffer;
  /** Hash corto del contenido: cambia con el archivo y invalida la caché tras un despliegue. */
  version: string;
}

const base = new URL("./assets/", import.meta.url);

function load(file: string, url: string, type: string): StaticAsset {
  const body = readFileSync(new URL(file, base));
  const version = createHash("sha256").update(body).digest("hex").slice(0, 10);
  return { url, type, body, version };
}

export const STYLESHEET = load("styles.css", "/assets/styles.css", "text/css; charset=utf-8");
export const FONT_INTER = load("fonts/inter-var-latin.woff2", "/assets/fonts/inter-var-latin.woff2", "font/woff2");
export const FONT_MANROPE = load("fonts/manrope-var-latin.woff2", "/assets/fonts/manrope-var-latin.woff2", "font/woff2");

export const ASSETS: readonly StaticAsset[] = [STYLESHEET, FONT_INTER, FONT_MANROPE];

/** URL de la hoja con su versión (`?v=`), para que un archivo nuevo no se sirva desde la caché del navegador. */
export function stylesheetUrl(): string {
  return `${STYLESHEET.url}?v=${STYLESHEET.version}`;
}
