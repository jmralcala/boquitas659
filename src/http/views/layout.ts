import { escapeHtml, html, type SafeHtml } from "../../lib/html.js";

/** Página HTML completa en español, con el aviso de privacidad y el canal de derechos siempre en el pie. */
export function page(options: { title: string; content: SafeHtml }): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(options.title)}</title>
</head>
<body>
<main>
${options.content.toString()}
</main>
<footer>
${html`<p><a href="/legal">Aviso de privacidad y términos</a> · <a href="/derechos">Tus derechos sobre tus datos</a></p>`.toString()}
</footer>
</body>
</html>`;
}
