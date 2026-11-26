import type { FastifyInstance } from "fastify";
import type { Services } from "../../compose.js";
import { isFullyAuthenticated } from "../../http/session-plugin.js";
import { landingPage } from "../../http/views/landing.js";
import { HOME_BY_ROLE } from "../auth/routes.js";

/** Límite de peticiones por IP de la portada: el mismo (120 por minuto) que el micrositio público. */
const HOME_RATE_LIMIT = { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } } as const;

/**
 * Portada pública de la raíz del sitio (contracts/http-routes.md). No lee entrada ni consulta la base: con sesión completa
 * redirige al inicio del rol (la misma tabla que usa `/login`); sin sesión o con la sesión a medias muestra la portada.
 * No establece cookies.
 */
export function registerHomeRoutes(app: FastifyInstance, services: Services): void {
  app.get("/", HOME_RATE_LIMIT, async (request, reply) => {
    if (isFullyAuthenticated(request.auth)) return reply.redirect(HOME_BY_ROLE[request.auth.role], 303);
    return reply
      .type("text/html; charset=utf-8")
      .send(landingPage({ year: services.clock.now().getUTCFullYear(), contactEmail: services.env.RIGHTS_CONTACT_EMAIL }));
  });
}
