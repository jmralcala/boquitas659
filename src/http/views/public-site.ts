import { html, type SafeHtml } from "../../lib/html.js";
import { icon, logo } from "./icons.js";
import { documentHead } from "./layout.js";

/**
 * Marco compartido de las páginas públicas (portada y páginas informativas de la feature 8). Arma el documento completo
 * con la barra única, el `<main>` que aporta cada página y el pie. No usa `page()` ni emite las marcas del shell: nunca
 * lleva barra lateral ni «Salir». La barra es idéntica en las cuatro páginas; solo cambia la entrada marcada.
 */

export const REGISTER_PATH = "/medicos/registro";
export const LOGIN_PATH = "/login";

export type MenuKey = "inicio" | "como-funciona" | "planes" | "nosotros";

export const MENU: ReadonlyArray<{ key: MenuKey; label: string; href: string }> = [
  { key: "inicio", label: "Inicio", href: "/" },
  { key: "como-funciona", label: "Cómo funciona", href: "/como-funciona" },
  { key: "planes", label: "Planes", href: "/planes" },
  { key: "nosotros", label: "Nosotros", href: "/nosotros" },
];

export interface PublicPageOptions {
  current: MenuKey;
  title: string;
  description: string;
  main: SafeHtml;
  year: number;
  contactEmail: string;
}

export function publicDocument(options: PublicPageOptions): string {
  const menu = MENU.map(
    (item) => html`<li><a href="${item.href}"${item.key === options.current ? html` aria-current="page"` : null}>${item.label}</a></li>`,
  );
  const content = html`<a class="skip-link" href="#contenido">Saltar al contenido</a>
<header class="topbar">
<div class="topbar__inner">
<a class="brand" href="/"><span class="brand__logo">${logo()}</span><span class="brand__name">Agenda Dental</span></a>
<nav aria-label="Principal">
<ul class="topbar__menu">${menu}</ul>
<div class="topbar__actions">
<a href="${REGISTER_PATH}">Registrarme</a>
<a class="btn btn-secondary" href="${LOGIN_PATH}">${icon("log-in")}Iniciar sesión</a>
</div>
</nav>
</div>
</header>
<main id="contenido">
${options.main}
</main>
<footer class="landing-footer">
<div class="landing-footer__inner">
<p>© ${options.year} Agenda Dental</p>
<nav aria-label="Información">
<a href="/legal/doctor_privacy">Aviso de privacidad</a>
<a href="/legal/terms_doctor">Términos y condiciones</a>
<a href="mailto:${options.contactEmail}" title="Escribir a ${options.contactEmail}">Contacto</a>
</nav>
</div>
</footer>`;
  return `<!doctype html>
<html lang="es">
${documentHead({ title: options.title, description: options.description })}
<body class="landing">
${content.toString()}
</body>
</html>`;
}
