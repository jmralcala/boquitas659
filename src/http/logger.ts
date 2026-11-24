import type { FastifyLoggerOptions, FastifyRequest } from "fastify";
import type { PinoLoggerOptions } from "fastify/types/logger.js";

type LoggerConfig = FastifyLoggerOptions & PinoLoggerOptions;

/**
 * Configuración de registro técnico (pino vía Fastify) sin datos personales:
 * - la URL se registra como plantilla de ruta (`/recuperar/:token`), no con el valor real;
 * - no se registran cabeceras ni cuerpos de petición;
 * - los errores se registran con tipo y código; el mensaje solo en desarrollo, porque los mensajes
 *   de la base de datos pueden incluir valores (por ejemplo un correo duplicado).
 */
export function loggerOptions(appEnv: "development" | "production"): LoggerConfig {
  // El serializador de errores omite `message` y `stack` a propósito (pueden contener datos personales),
  // por eso se castea: la firma de tipos de Fastify los exige aunque pino acepta un objeto parcial.
  const config = {
    level: appEnv === "production" ? "info" : "debug",
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        'res.headers["set-cookie"]',
        "password",
        "passwordConfirm",
        "currentPassword",
        "newPassword",
        "token",
        "email",
        "newEmail",
        "*.password",
        "*.passwordConfirm",
        "*.currentPassword",
        "*.newPassword",
        "*.token",
        "*.email",
        "*.newEmail",
        // Urgencias (constitución I): la categoría del triaje, las señales de alarma y el token del CAPTCHA nunca se registran.
        "categoria",
        "category",
        "senales",
        '["cf-turnstile-response"]',
        "*.categoria",
        "*.category",
        "*.senales",
        '*["cf-turnstile-response"]',
      ],
      censor: "[redactado]",
    },
    serializers: {
      req(request: FastifyRequest) {
        return {
          method: request.method,
          url: request.routeOptions?.url ?? "(sin ruta)",
        };
      },
      res(reply: { statusCode?: number }) {
        return { statusCode: reply.statusCode };
      },
      err(error: Error & { code?: string; errno?: number }) {
        return {
          type: error.name,
          code: error.code,
          errno: error.errno,
          ...(appEnv === "development" ? { message: error.message } : {}),
        };
      },
    },
  };
  return config as unknown as LoggerConfig;
}
