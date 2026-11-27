import type { FastifyInstance } from "fastify";
import { wantsJson } from "./negotiation.js";
import { PUBLIC_INFO_PATHS } from "./public-paths.js";
import { isFullyAuthenticated } from "./session-plugin.js";

/** Lo único que soporte puede usar mientras no tenga el doble factor activo: alta del doble factor, avisos y salir. */
function isExempt(url: string | undefined): boolean {
  if (url === undefined) return true; // sin ruta (404)
  if (PUBLIC_INFO_PATHS.includes(url)) return true; // páginas informativas públicas (feature 8)
  return (
    url === "/cuenta/mfa" ||
    url.startsWith("/cuenta/mfa/") ||
    url === "/logout" ||
    url === "/login" ||
    url === "/derechos" ||
    url.startsWith("/legal") ||
    url.startsWith("/assets/") // hoja de estilos y fuentes de la propia pantalla de alta
  );
}

/**
 * Doble factor obligatorio para soporte (aprueba cuentas y ve cédulas). Una cuenta de soporte sin TOTP activo solo
 * puede llegar a la pantalla de alta: navegadores a 303 `/cuenta/mfa/alta`, clientes JSON a 403. Si el TOTP está
 * activo pero la sesión no lo verificó, la sesión está "a medias" y `requireAuth` ya responde 401.
 */
export function installSupportMfa(app: FastifyInstance): void {
  app.addHook("preHandler", async (request, reply) => {
    const auth = request.auth;
    if (!isFullyAuthenticated(auth) || auth.role !== "support" || auth.mfaEnabled) return;
    if (isExempt(request.routeOptions?.url)) return;

    if (wantsJson(request)) {
      return reply.code(403).send({
        error: "mfa_enrollment_required",
        message: "Soporte debe activar el doble factor antes de continuar.",
        enroll: "/cuenta/mfa/alta",
      });
    }
    return reply.redirect("/cuenta/mfa/alta", 303);
  });
}
