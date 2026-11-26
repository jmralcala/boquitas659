import type { Writable } from "node:stream";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { html } from "../lib/html.js";
import type { SessionService } from "../modules/auth/sessions.js";
import type { LegalService } from "../modules/legal/legal-service.js";
import { installLegalGate } from "../modules/legal/legal-gate.js";
import { installCsrf } from "./csrf.js";
import { AppError, NotFoundError, TooManyAttemptsError } from "./errors.js";
import { loggerOptions } from "./logger.js";
import { wantsJson } from "./negotiation.js";
import { installSession } from "./session-plugin.js";
import { installShell } from "./shell.js";
import { installSupportMfa } from "./support-mfa.js";
import { page } from "./views/layout.js";

export interface AppOptions {
  appEnv: "development" | "production";
  /** Confianza en el proxy del hosting para leer la IP real: número de saltos o lista de IP/CIDR. Nunca `true`. */
  trustProxy?: false | number | string[];
  /** Servicio de sesiones. Si se entrega junto con `csrfSecret`, se activan sesión y CSRF. */
  sessions?: SessionService;
  /** Secreto para derivar los tokens CSRF (`SESSION_SECRET`). */
  csrfSecret?: string;
  /** Servicio legal: activa el filtro que exige aceptar las versiones vigentes de los avisos. */
  legal?: LegalService;
  /** Solo para pruebas: destino alternativo de los registros. */
  logStream?: Writable;
}

/**
 * Fastify no tipa el número de saltos, pero sí admite una función `(dirección, salto)`: se confía solo en los
 * primeros `n` saltos (los proxies propios) y se ignora lo que un cliente escriba más allá en `X-Forwarded-For`.
 */
function toFastifyTrustProxy(value: AppOptions["trustProxy"]): boolean | string[] | ((address: string, hop: number) => boolean) {
  if (value === undefined || value === false) return false;
  if (typeof value === "number") return (_address, hop) => hop < value;
  return value;
}

/** Únicas rutas que reciben archivos (cédula del médico). En el resto, multipart se rechaza antes de leer el cuerpo. */
const MULTIPART_ROUTES = new Set(["/medicos/registro", "/medicos/estado/reenviar", "/medicos/micrositio/logo"]);

function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  fields?: Readonly<Record<string, readonly string[]>>,
): FastifyReply {
  void reply.status(status);
  if (wantsJson(request)) {
    return reply.type("application/json").send({ error: code, message, ...(fields ? { fields } : {}) });
  }
  const items = fields
    ? Object.entries(fields).flatMap(([name, messages]) => messages.map((m) => html`<li>${name}: ${m}</li>`))
    : [];
  // Las páginas de error también usan el diseño común (hoja, pie legal y, con sesión, la barra lateral).
  const content = html`<h1>${message}</h1>${items.length > 0 ? html`<ul class="errors">${items}</ul>` : null}`;
  return reply.type("text/html; charset=utf-8").send(page({ title: "Error", content, size: "narrow" }));
}

/**
 * Fábrica de la aplicación Fastify: cabeceras de seguridad, cookies, límite de peticiones y
 * manejo uniforme de errores (sin detalles internos hacia el cliente).
 */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { ...loggerOptions(options.appEnv), ...(options.logStream ? { stream: options.logStream } : {}) },
    trustProxy: toFastifyTrustProxy(options.trustProxy),
  });

  // CSP solo con recursos propios: el navegador impide cualquier hoja, fuente o imagen de terceros (FR-016, SC-005).
  // `useDefaults` conserva el valor actual de las demás directivas (por ejemplo `upgrade-insecure-requests`); aquí se
  // sobrescriben las que por defecto admitían cualquier origen `https:` y los estilos en línea.
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        fontSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  });
  await app.register(cookie);
  await app.register(formbody);
  // Los archivos llegan como Buffer dentro de `request.body` (así el CSRF y zod ven todos los campos).
  await app.register(multipart, {
    attachFieldsToBody: "keyValues",
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 20, parts: 25 },
  });
  await app.register(rateLimit, { global: true, max: 300, timeWindow: "1 minute" });

  if (options.sessions && options.csrfSecret) {
    installSession(app, options.sessions);
    installCsrf(app, options.csrfSecret);
    installSupportMfa(app);
    if (options.legal) installLegalGate(app, options.legal);
  }

  // Evita que cualquier POST anónimo haga leer hasta 5 MB en memoria antes de que el filtro CSRF lo rechace.
  app.addHook("onRequest", async (request, reply) => {
    const type = request.headers["content-type"];
    if (typeof type === "string" && type.toLowerCase().startsWith("multipart/") && !MULTIPART_ROUTES.has(request.routeOptions?.url ?? "")) {
      return sendError(request, reply, 415, "unsupported_media_type", "Este formulario no admite archivos.");
    }
  });

  app.addHook("onSend", async (request, reply) => {
    void reply.header("x-request-id", request.id);
  });

  // El micrositio y las pantallas del paciente no se indexan (no hay directorio de consultorios): además de la meta de
  // las páginas HTML, la cabecera cubre también las respuestas de error y las imágenes.
  app.addHook("onSend", async (request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    if (path.startsWith("/c/") || path.startsWith("/citas/") || path.startsWith("/pacientes/") || path.startsWith("/soporte")) {
      void reply.header("x-robots-tag", "noindex, nofollow");
    }
    // El panel de soporte nunca se cachea, ni en HTML ni en JSON.
    if (path.startsWith("/soporte")) void reply.header("cache-control", "no-store");
  });

  // Estructura común del diseño: barra lateral con la navegación del rol y «Salir» cuando hay sesión, tarjeta centrada
  // cuando no, y el aviso de solo lectura (feature 5) arriba del contenido. Ver shell.ts.
  installShell(app, options.csrfSecret);

  // Las páginas pueden contener códigos de recuperación, secretos TOTP, enlaces con token o datos de pacientes:
  // no deben quedar en cachés ni reaparecer con «atrás» tras cerrar sesión.
  app.addHook("onSend", async (_request, reply) => {
    if (String(reply.getHeader("content-type") ?? "").startsWith("text/html") && !reply.hasHeader("cache-control")) {
      void reply.header("cache-control", "no-store");
    }
  });

  app.setNotFoundHandler((request, reply) => {
    const error = new NotFoundError();
    return sendError(request, reply, error.status, error.code, error.publicMessage);
  });

  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, request, reply) => {
    if (error instanceof AppError) {
      if (error instanceof TooManyAttemptsError) {
        void reply.header("retry-after", String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))));
      }
      return sendError(request, reply, error.status, error.code, error.publicMessage, error.fields);
    }
    const status = typeof error.statusCode === "number" ? error.statusCode : 500;
    if (status === 413) {
      return sendError(request, reply, 413, "payload_too_large", "El archivo es demasiado grande (máximo 5 MB).");
    }
    if (status === 429) {
      return sendError(request, reply, 429, "rate_limited", "Demasiadas peticiones. Intenta de nuevo en un momento.");
    }
    if (status >= 400 && status < 500) {
      request.log.warn({ err: error }, "petición rechazada");
      return sendError(request, reply, status, "bad_request", "La petición no es válida.");
    }
    // El mensaje fijo evita que el texto del error (que puede traer datos) llegue al registro.
    request.log.error({ err: error }, "error de petición");
    return sendError(request, reply, 500, "internal_error", "Ocurrió un error. Intenta de nuevo más tarde.");
  });

  return app;
}
