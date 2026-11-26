import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { ForbiddenError, UnauthorizedError } from "./errors.js";
import type { SessionData, SessionService, UserRole } from "../modules/auth/sessions.js";

/** Prefijo `__Host-`: la cookie exige `Secure`, `Path=/` y no admite `Domain`. */
export const SESSION_COOKIE = "__Host-sid";

declare module "fastify" {
  interface FastifyRequest {
    /** Sesión vigente o `null`. Puede estar a medias si falta el segundo factor (`mfaEnabled && !mfaVerified`). */
    auth: SessionData | null;
    sessionToken: string | null;
  }
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  void reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: "lax", path: "/" });
}

export function clearSessionCookie(reply: FastifyReply): void {
  void reply.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: true, sameSite: "lax", path: "/" });
}

/** Lee la cookie de sesión en cada petición y deja `request.auth`. */
export function installSession(app: FastifyInstance, sessions: SessionService): void {
  app.decorateRequest("auth", null);
  app.decorateRequest("sessionToken", null);
  app.addHook("onRequest", async (request) => {
    // La hoja de estilos y las fuentes (`/assets/`) no dependen de la sesión: validarla costaría una lectura y una
    // escritura en la base por cada recurso de cada página.
    if (request.url.startsWith("/assets/")) return;
    const token = request.cookies[SESSION_COOKIE];
    if (typeof token === "string" && token.length > 0) {
      request.sessionToken = token;
      request.auth = await sessions.validate(token);
    }
  });
}

/** Sesión completa: existe y, si el usuario tiene doble factor, ya lo verificó. */
export function isFullyAuthenticated(auth: SessionData | null): auth is SessionData {
  return auth !== null && (!auth.mfaEnabled || auth.mfaVerified);
}

export function requireAuth(request: FastifyRequest): SessionData {
  if (!isFullyAuthenticated(request.auth)) throw new UnauthorizedError();
  return request.auth;
}

/** Guarda de rol para usar como `preHandler`. 401 sin sesión, 403 con un rol que no corresponde. */
export function requireRole(...roles: UserRole[]): preHandlerHookHandler {
  return async (request) => {
    const auth = requireAuth(request);
    if (!roles.includes(auth.role)) throw new ForbiddenError();
  };
}
