import type { FastifyInstance } from "fastify";
import { html, type SafeHtml } from "../lib/html.js";
import type { UserRole } from "../modules/auth/sessions.js";
import { accountStateOf } from "../modules/reception/tenant-resolver.js";
import { sessionCsrfToken } from "./csrf.js";
import { icon, logo, type IconName } from "./views/icons.js";
import { alert } from "./views/ui.js";
import { SHELL_CLOSE, SHELL_OPEN } from "./views/layout.js";

/**
 * Estructura común de las pantallas (contracts/ui-shell.md). `page()` deja marcas fijas y este gancho las sustituye:
 * sin sesión, la tarjeta centrada; con sesión, la barra lateral con la navegación del rol y «Salir». Así ninguna de las
 * ~60 pantallas conoce el rol ni la página activa, y una pantalla nueva hereda todo sin trabajo adicional.
 */

interface NavItem {
  href: string;
  label: string;
  icon: IconName;
}

/** Solo enlaces que existen hoy para cada rol (FR-005). */
const NAV: Readonly<Record<UserRole, readonly NavItem[]>> = {
  doctor: [
    { href: "/medicos/inicio", label: "Inicio", icon: "home" },
    { href: "/agenda", label: "Agenda", icon: "calendar" },
    { href: "/agenda/bloqueos", label: "Bloqueos", icon: "ban" },
    { href: "/agenda/configuracion", label: "Configuración", icon: "settings" },
    { href: "/medicos/micrositio", label: "Mi micrositio", icon: "globe" },
    { href: "/medicos/recepcion", label: "Recepción", icon: "users" },
  ],
  reception: [
    { href: "/recepcion/panel", label: "Inicio", icon: "home" },
    { href: "/agenda", label: "Agenda", icon: "calendar" },
    { href: "/agenda/bloqueos", label: "Bloqueos", icon: "ban" },
  ],
  patient: [
    { href: "/pacientes/panel", label: "Inicio", icon: "home" },
    { href: "/pacientes/citas", label: "Mis citas", icon: "appointments" },
    { href: "/pacientes/consultorios", label: "Mis consultorios", icon: "building" },
  ],
  support: [
    { href: "/soporte", label: "Resumen", icon: "home" },
    { href: "/soporte/medicos", label: "Médicos", icon: "doctors" },
    { href: "/soporte/micrositios", label: "Micrositios", icon: "globe" },
    { href: "/soporte/correos", label: "Correos", icon: "mail" },
    { href: "/soporte/metricas", label: "Métricas", icon: "chart" },
    { href: "/soporte/historial", label: "Historial", icon: "history" },
  ],
};

const ROLE_LABEL: Readonly<Record<UserRole, string>> = {
  doctor: "Médico",
  reception: "Recepción",
  patient: "Paciente",
  support: "Soporte",
};

const HOME: Readonly<Record<UserRole, string>> = {
  doctor: "/medicos/inicio",
  reception: "/recepcion/panel",
  patient: "/pacientes/panel",
  support: "/soporte/medicos",
};

/** Entrada activa: la de prefijo de ruta más largo que coincide en un límite de segmento (`/agenda` sí cubre `/agenda/dia/…`). */
export function activeHref(items: readonly NavItem[], path: string): string | null {
  let best: string | null = null;
  for (const item of items) {
    const matches = path === item.href || path.startsWith(`${item.href}/`);
    if (matches && (best === null || item.href.length > best.length)) best = item.href;
  }
  return best;
}

function navigation(role: UserRole, path: string): SafeHtml {
  const items = NAV[role];
  const active = activeHref(items, path);
  return html`<nav aria-label="Principal"><ul>${items.map(
    (item) =>
      html`<li><a${item.href === active ? html` class="is-active" aria-current="page"` : null} href="${item.href}">${icon(item.icon)}<span>${item.label}</span></a></li>`,
  )}</ul></nav>`;
}

function sidebar(role: UserRole, path: string, csrf: string, withNavigation: boolean): SafeHtml {
  return html`<aside class="sidebar">
<a class="brand" href="${HOME[role]}"><span class="brand__logo">${logo()}</span><span class="brand__name">Agenda Dental</span></a>
${withNavigation ? navigation(role, path) : null}
<div class="user-card">
<span class="user-card__avatar" aria-hidden="true">${ROLE_LABEL[role].slice(0, 1)}</span>
<span class="user-card__role">${ROLE_LABEL[role]}</span>
<form method="post" action="/logout"><input type="hidden" name="_csrf" value="${csrf}"><button type="submit" class="btn-secondary">${icon("logout")}Salir</button></form>
</div>
</aside>`;
}

export function installShell(app: FastifyInstance, csrfSecret: string | undefined): void {
  app.addHook("onSend", async (request, reply, payload) => {
    if (typeof payload !== "string" || !payload.includes(SHELL_OPEN)) return payload;
    if (!String(reply.getHeader("content-type") ?? "").startsWith("text/html")) return payload;

    const auth = request.auth;
    if (!auth || csrfSecret === undefined) return payload.replace(SHELL_OPEN, "").replace(SHELL_CLOSE, "");

    const path = request.url.split("?")[0] ?? "";
    // Con la sesión a medias (segundo factor pendiente o por activar en soporte) o ante los avisos por aceptar, los
    // enlaces de la navegación redirigirían: solo se ofrece «Salir».
    const partial = (auth.mfaEnabled && !auth.mfaVerified) || (auth.role === "support" && !auth.mfaEnabled) || path === "/legal/aceptar";
    const csrf = sessionCsrfToken(csrfSecret, auth.csrfSecret);
    const notice =
      accountStateOf(request) === "read_only"
        ? alert("info", html`<strong>Tu cuenta está en solo lectura:</strong> puedes consultar tu agenda, pero no modificarla.`)
        : null;

    const open = html`<div class="app">${sidebar(auth.role, path, csrf, !partial)}<div class="main">`.toString();
    let out = payload
      .replace(/<body class="card-page[^"]*">/, '<body class="has-shell">')
      .replace(SHELL_OPEN, () => open)
      .replace(SHELL_CLOSE, "</div></div>");
    if (notice) out = out.replace('<main id="contenido">', () => `<main id="contenido">\n${notice.toString()}`);
    return out;
  });
}
