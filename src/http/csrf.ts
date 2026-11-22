import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { generateToken } from "../lib/tokens.js";
import { ForbiddenError } from "./errors.js";

/** Cookie de doble envío para formularios sin sesión (login, registro, recuperación). */
export const ANON_CSRF_COOKIE = "__Host-csrf";
export const CSRF_FIELD = "_csrf";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function hmac(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Token CSRF de una sesión (derivado del secreto de la aplicación y del secreto CSRF de la sesión). */
export function sessionCsrfToken(secret: string, sessionCsrfSecret: string): string {
  return hmac(secret, `s:${sessionCsrfSecret}`);
}

export interface Csrf {
  /** Token para el formulario de la petición actual (de sesión o, sin sesión, de doble envío). */
  tokenFor(request: FastifyRequest, reply: FastifyReply): string;
}

declare module "fastify" {
  interface FastifyInstance {
    csrf: Csrf;
  }
}

/**
 * Protección CSRF para rutas que cambian estado (POST, PUT, PATCH, DELETE).
 * - Con sesión: token sincronizador derivado del secreto CSRF de la sesión.
 * - Sin sesión: doble envío firmado (cookie aleatoria + token derivado con HMAC).
 * `GET` nunca cambia estado y no se valida.
 */
export function installCsrf(app: FastifyInstance, secret: string): void {
  const csrf: Csrf = {
    tokenFor(request, reply) {
      if (request.auth) return sessionCsrfToken(secret, request.auth.csrfSecret);
      let cookieValue = request.cookies[ANON_CSRF_COOKIE];
      if (typeof cookieValue !== "string" || cookieValue.length === 0) {
        cookieValue = generateToken();
        void reply.setCookie(ANON_CSRF_COOKIE, cookieValue, {
          httpOnly: true,
          secure: true,
          sameSite: "lax",
          path: "/",
        });
        request.cookies[ANON_CSRF_COOKIE] = cookieValue;
      }
      return hmac(secret, `a:${cookieValue}`);
    },
  };
  app.decorate("csrf", csrf);

  app.addHook("preHandler", async (request) => {
    if (!UNSAFE_METHODS.has(request.method)) return;

    const body = request.body as Record<string, unknown> | undefined | null;
    const fromBody = body && typeof body === "object" ? body[CSRF_FIELD] : undefined;
    const fromHeader = request.headers["x-csrf-token"];
    const provided = typeof fromBody === "string" ? fromBody : typeof fromHeader === "string" ? fromHeader : "";

    let expected: string | null;
    if (request.auth) {
      expected = sessionCsrfToken(secret, request.auth.csrfSecret);
    } else {
      const cookieValue = request.cookies[ANON_CSRF_COOKIE];
      expected = typeof cookieValue === "string" && cookieValue.length > 0 ? hmac(secret, `a:${cookieValue}`) : null;
    }

    if (expected === null || provided.length === 0 || !safeEqual(provided, expected)) {
      throw new ForbiddenError("El formulario venció o no es válido. Recarga la página e inténtalo de nuevo.");
    }
  });
}
