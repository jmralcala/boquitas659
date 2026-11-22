import type { FastifyInstance } from "fastify";
import type { Env } from "./config/env.js";
import { createPool, type Db } from "./db/pool.js";
import { buildApp } from "./http/app.js";
import { systemClock, type Clock } from "./lib/clock.js";
import { defaultTemplates } from "./mail/templates.js";
import { createOneTimeTokenService, type OneTimeTokenService } from "./modules/auth/one-time-tokens.js";
import { createPasswordHasher, type PasswordHasher } from "./modules/auth/password-hasher.js";
import { registerAuthRoutes } from "./modules/auth/routes.js";
import { createSessionService, type SessionService } from "./modules/auth/sessions.js";
import { createCedulaStorage, type CedulaStorage } from "./modules/doctors/cedula-storage.js";
import { createDoctorService, type DoctorService } from "./modules/doctors/doctor-service.js";
import { createDoctorGuards, type DoctorGuards } from "./modules/doctors/guards.js";
import { registerDoctorRegistrationRoutes } from "./modules/doctors/registration-routes.js";
import { registerDoctorStatusRoutes } from "./modules/doctors/status-routes.js";
import { createLegalService, type LegalService } from "./modules/legal/legal-service.js";
import { seedProvisionalDocuments } from "./modules/legal/seed-provisional.js";
import { createSupportService, type SupportService } from "./modules/support/support-service.js";
import { registerSupportRoutes } from "./modules/support/support-routes.js";

export interface Services {
  env: Env;
  db: Db;
  clock: Clock;
  sessions: SessionService;
  hasher: PasswordHasher;
  legal: LegalService;
  tokens: OneTimeTokenService;
  cedulaStorage: CedulaStorage;
  templates: typeof defaultTemplates;
  doctors: DoctorService;
  doctorGuards: DoctorGuards;
  support: SupportService;
}

export interface ComposeOptions {
  env: Env;
  db: Db;
  clock?: Clock;
  hasher?: PasswordHasher;
}

/**
 * Raíz de composición: crea los servicios y registra los módulos de la aplicación sobre un pool existente.
 * Cada historia de usuario añade aquí el registro de sus rutas.
 */
export async function composeApp(options: ComposeOptions): Promise<{ app: FastifyInstance; services: Services }> {
  const { env, db } = options;
  const clock = options.clock ?? systemClock;
  const sessions = createSessionService(db, clock);
  const hasher = options.hasher ?? createPasswordHasher(env.PASSWORD_HASHER);
  const legal = createLegalService(db, clock);
  const cedulaStorage = createCedulaStorage(env.CEDULA_STORAGE_DIR);
  const services: Services = {
    env,
    db,
    clock,
    sessions,
    hasher,
    legal,
    tokens: createOneTimeTokenService(db, clock),
    cedulaStorage,
    templates: defaultTemplates,
    doctors: createDoctorService({ db, hasher, legal, cedulaStorage, clock, supportEmail: env.SUPPORT_EMAIL }),
    doctorGuards: createDoctorGuards(db),
    support: createSupportService(db, clock),
  };

  // Garantiza que existan los textos legales (provisionales); en producción bloquean las altas hasta revisarse.
  await seedProvisionalDocuments(services.legal);

  const app = await buildApp({
    appEnv: env.APP_ENV,
    trustProxy: env.TRUST_PROXY,
    sessions: services.sessions,
    csrfSecret: env.SESSION_SECRET,
  });

  registerAuthRoutes(app, services);
  registerDoctorRegistrationRoutes(app, services);
  registerDoctorStatusRoutes(app, services);
  registerSupportRoutes(app, services);

  return { app, services };
}

export interface Server {
  app: FastifyInstance;
  db: Db;
  close(): Promise<void>;
}

export async function createServer(env: Env): Promise<Server> {
  const db = createPool(env.DATABASE_URL);
  const { app } = await composeApp({ env, db });
  return {
    app,
    db,
    async close() {
      await app.close();
      await db.end();
    },
  };
}
