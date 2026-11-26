import type { FastifyInstance } from "fastify";
import { ASSETS } from "./asset-url.js";

/**
 * Límite de peticiones propio de los recursos del diseño: una página pide 3, así que 600 por minuto por IP
 * dejan margen a una oficina entera detrás de la misma IP sin abrir la puerta a un abuso.
 */
const ASSET_RATE_LIMIT = { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } } as const;

/**
 * Recursos estáticos del diseño (contracts/assets-and-components.md). Cada archivo es una ruta literal: cualquier otro
 * nombre bajo `/assets/` cae en el 404 uniforme de la aplicación, sin construir nunca una ruta de disco con la petición.
 */
export function registerAssetRoutes(app: FastifyInstance): void {
  for (const asset of ASSETS) {
    app.get(asset.url, ASSET_RATE_LIMIT, async (_request, reply) => {
      void reply.header("cache-control", "public, max-age=31536000, immutable");
      void reply.header("x-content-type-options", "nosniff");
      return reply.type(asset.type).send(asset.body);
    });
  }
}
