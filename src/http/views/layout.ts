import { escapeHtml, html, type SafeHtml } from "../../lib/html.js";
import { FONT_INTER, FONT_MANROPE, stylesheetUrl } from "../asset-url.js";

/** Marcas que el gancho de `shell.ts` sustituye según haya o no sesión (contracts/ui-shell.md). */
export const SHELL_OPEN = "<!--shell:open-->";
export const SHELL_CLOSE = "<!--shell:close-->";
/** Apertura del contenido principal: `shell.ts` la busca para añadir avisos arriba; comparten esta constante para no desincronizarse. */
export const MAIN_OPEN = '<main id="contenido">';

/** Ancho de la tarjeta de las pantallas sin sesión: formularios cortos (`narrow`) o contenido normal. */
export type PageSize = "narrow" | "normal";

/**
 * Página HTML completa en español, con el diseño común, el aviso de privacidad y el canal de derechos siempre en el pie.
 * Todo lo que pasa por aquí hereda hoja de estilos, fuentes propias, salto al contenido y la estructura con barra lateral
 * cuando hay sesión (ver `shell.ts`). Ninguna pantalla debe armar su propio `<html>`.
 */
export function page(options: { title: string; content: SafeHtml; size?: PageSize }): string {
  const size = options.size === "narrow" ? " card-page--narrow" : "";
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(options.title)}</title>
<link rel="preload" href="${FONT_INTER.url}" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="${FONT_MANROPE.url}" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${stylesheetUrl()}">
</head>
<body class="card-page${size}">
<a class="skip-link" href="#contenido">Saltar al contenido</a>
${SHELL_OPEN}
${MAIN_OPEN}
${options.content.toString()}
</main>
<footer class="site-footer">
${html`<p><a href="/legal">Aviso de privacidad y términos</a> · <a href="/derechos">Tus derechos sobre tus datos</a></p>`.toString()}
</footer>
${SHELL_CLOSE}
</body>
</html>`;
}
