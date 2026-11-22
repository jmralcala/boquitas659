import type { FastifyInstance } from "fastify";
import type { Env } from "./config/env.js";
import { createPool, type Db } from "./db/pool.js";
import { buildApp } from "./http/app.js";
import { registerAuthRoutes } from "./modules/auth/routes.js";
import { createPasswordHasher } from "./modules/auth/password-hasher.js";
import { createSessionService } from "./modules/auth/sessions.js";
import { createLegalService } from "./modules/legal/legal-service.js";
import { seedProvisionalDocuments } from "./modules/legal/seed-provisional.js";

export interface Server {
  app: FastifyInstance;
  db: Db;
  close(): Promise<void>;
}

/**
 * Raíz de composición: crea el pool, los servicios y registra los módulos de la aplicación.
 * Cada historia de usuario añade aquí el registro de sus rutas.
 */
export async function createServer(env: Env): Promise<Server> {
  const db = createPool(env.DATABASE_URL);
  const sessions = createSessionService(db);
  const hasher = createPasswordHasher(env.PASSWORD_HASHER);
  const legal = createLegalService(db);

  // Garantiza que existan los textos legales (provisionales); en producción bloquean las altas hasta revisarse.
  await seedProvisionalDocuments(legal);

  const app = await buildApp({
    appEnv: env.APP_ENV,
    trustProxy: env.TRUST_PROXY,
    sessions,
    csrfSecret: env.SESSION_SECRET,
  });

  registerAuthRoutes(app, { db, sessions, hasher });

  return {
    app,
    db,
    async close() {
      await app.close();
      await db.end();
    },
  };
}
