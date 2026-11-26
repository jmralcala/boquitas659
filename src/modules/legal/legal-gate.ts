import type { FastifyInstance } from "fastify";
import { wantsJson } from "../../http/negotiation.js";
import { isFullyAuthenticated } from "../../http/session-plugin.js";
import type { LegalService } from "./legal-service.js";

/** Rutas que deben seguir disponibles para quien tiene avisos pendientes: textos, derechos, aceptar, entrar y salir. */
function isExempt(url: string | undefined): boolean {
  if (url === undefined) return true; // sin ruta (404): no hay nada que proteger
  // `/assets/` son la hoja de estilos y las fuentes: sin ellas la propia pantalla de aceptación se vería sin estilo.
  return url === "/derechos" || url === "/logout" || url === "/login" || url.startsWith("/legal") || url.startsWith("/assets/");
}

/**
 * Filtro global: si la última versión de algún documento que aplica al rol del usuario no ha sido aceptada,
 * se bloquea el uso del producto hasta aceptarla (FR-021). Navegadores: 303 a `/legal/aceptar`;
 * clientes JSON: 403 con `legal_acceptance_required`. Se registra después del filtro CSRF.
 */
export function installLegalGate(app: FastifyInstance, legal: LegalService): void {
  app.addHook("preHandler", async (request, reply) => {
    const auth = request.auth;
    if (!isFullyAuthenticated(auth) || isExempt(request.routeOptions?.url)) return;

    const pending = await legal.pendingFor(auth.userId, auth.role);
    if (pending.length === 0) return;

    if (wantsJson(request)) {
      return reply.code(403).send({
        error: "legal_acceptance_required",
        message: "Debes aceptar la versión vigente de los avisos para continuar.",
        accept: "/legal/aceptar",
      });
    }
    return reply.redirect("/legal/aceptar", 303);
  });
}
