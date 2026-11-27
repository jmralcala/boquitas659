import type { FastifyInstance, FastifyReply } from "fastify";
import type { Services } from "../../compose.js";
import { aboutPage } from "../../http/views/about.js";
import { howItWorksPage } from "../../http/views/how-it-works.js";
import { plansPage } from "../../http/views/plans.js";

/** Límite de peticiones por IP de las páginas informativas: el mismo (120 por minuto) que la portada. */
const INFO_RATE_LIMIT = { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } } as const;

type Render = (options: { year: number; contactEmail: string }) => string;

/**
 * Páginas informativas públicas (feature 8): contenido fijo, sin entrada, sin base de datos, sin cookies. A diferencia de
 * `/`, no redirigen con sesión: se muestran a cualquier persona (y están eximidas de los filtros globales, ver
 * `PUBLIC_INFO_PATHS`).
 */
export function registerInfoRoutes(app: FastifyInstance, services: Services): void {
  const show = (render: Render) => async (_request: unknown, reply: FastifyReply) =>
    reply.type("text/html; charset=utf-8").send(render({ year: services.clock.now().getUTCFullYear(), contactEmail: services.env.RIGHTS_CONTACT_EMAIL }));

  app.get("/como-funciona", INFO_RATE_LIMIT, show(howItWorksPage));
  app.get("/planes", INFO_RATE_LIMIT, show(plansPage));
  app.get("/nosotros", INFO_RATE_LIMIT, show(aboutPage));
}
