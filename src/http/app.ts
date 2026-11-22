import type { Writable } from "node:stream";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { html } from "../lib/html.js";
import type { SessionService } from "../modules/auth/sessions.js";
import { installCsrf } from "./csrf.js";
import { AppError, NotFoundError } from "./errors.js";
import { loggerOptions } from "./logger.js";
import { installSession } from "./session-plugin.js";

export interface AppOptions {
  appEnv: "development" | "production";
  /** Verdadero cuando la app corre detrás del proxy del hosting (para leer la IP real). */
  trustProxy?: boolean;
  /** Servicio de sesiones. Si se entrega junto con `csrfSecret`, se activan sesión y CSRF. */
  sessions?: SessionService;
  /** Secreto para derivar los tokens CSRF (`SESSION_SECRET`). */
  csrfSecret?: string;
  /** Solo para pruebas: destino alternativo de los registros. */
  logStream?: Writable;
}

function wantsJson(request: FastifyRequest): boolean {
  return (request.headers.accept ?? "").includes("application/json");
}

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
  const page = html`<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Error</title></head>
<body><main><h1>${message}</h1>${items.length > 0 ? html`<ul>${items}</ul>` : null}</main></body>
</html>`;
  return reply.type("text/html; charset=utf-8").send(page.toString());
}

/**
 * Fábrica de la aplicación Fastify: cabeceras de seguridad, cookies, límite de peticiones y
 * manejo uniforme de errores (sin detalles internos hacia el cliente).
 */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { ...loggerOptions(options.appEnv), ...(options.logStream ? { stream: options.logStream } : {}) },
    trustProxy: options.trustProxy ?? false,
  });

  await app.register(helmet);
  await app.register(cookie);
  await app.register(formbody);
  await app.register(rateLimit, { global: true, max: 300, timeWindow: "1 minute" });

  if (options.sessions && options.csrfSecret) {
    installSession(app, options.sessions);
    installCsrf(app, options.csrfSecret);
  }

  app.addHook("onSend", async (request, reply) => {
    void reply.header("x-request-id", request.id);
  });

  app.setNotFoundHandler((request, reply) => {
    const error = new NotFoundError();
    return sendError(request, reply, error.status, error.code, error.publicMessage);
  });

  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, request, reply) => {
    if (error instanceof AppError) {
      return sendError(request, reply, error.status, error.code, error.publicMessage, error.fields);
    }
    const status = typeof error.statusCode === "number" ? error.statusCode : 500;
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
