import type { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { Env } from "./config/env.js";
import { createPool, type Db } from "./db/pool.js";
import { buildApp } from "./http/app.js";
import { systemClock, type Clock } from "./lib/clock.js";
import { defaultTemplates } from "./mail/templates.js";
import { createDeviceService, type DeviceService } from "./modules/auth/devices.js";
import { createLoginThrottle, type LoginThrottle } from "./modules/auth/login-throttle.js";
import { createMfaService, type MfaService } from "./modules/auth/totp.js";
import { registerMfaRoutes } from "./modules/auth/mfa-routes.js";
import { createReauth, type Reauth } from "./modules/auth/reauth.js";
import { registerAccountRoutes } from "./modules/auth/account-routes.js";
import { registerRecoveryRoutes } from "./modules/auth/recovery-routes.js";
import { registerDoctorAccountRoutes } from "./modules/doctors/account-routes.js";
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
import { createDependentsService, type DependentsService } from "./modules/patients/dependents-service.js";
import { createPatientRegistration, type PatientRegistration } from "./modules/patients/registration-service.js";
import { registerPatientRoutes } from "./modules/patients/routes.js";
import { createInvitationService, type InvitationService } from "./modules/reception/invitation-service.js";
import { createMembershipService, type MembershipService } from "./modules/reception/membership-service.js";
import { registerReceptionRoutes } from "./modules/reception/routes.js";
import { createTenantResolver, type TenantResolver } from "./modules/reception/tenant-resolver.js";
import { registerPatientDetailRoutes } from "./modules/patients/detail-routes.js";
import { registerLegalRoutes } from "./modules/legal/routes.js";
import { registerSupportRoutes } from "./modules/support/support-routes.js";
import { registerCalendarRoutes } from "./modules/calendar/routes.js";

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
  patients: PatientRegistration;
  dependents: DependentsService;
  throttle: LoginThrottle;
  devices: DeviceService;
  reauth: Reauth;
  mfa: MfaService;
  invitations: InvitationService;
  memberships: MembershipService;
  tenants: TenantResolver;
}

export interface ComposeOptions {
  env: Env;
  db: Db;
  clock?: Clock;
  hasher?: PasswordHasher;
  /** Solo para pruebas: destino alternativo de los registros técnicos. */
  logStream?: Writable;
  /** Solo para pruebas: se invoca por cada ruta registrada (auditoría de rutas contra el contrato). */
  onRoute?: (route: { method: string | string[]; url: string }) => void;
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
  const throttle = createLoginThrottle(db, clock, env.SESSION_SECRET);
  // En producción, los avisos provisionales (sin revisión legal) bloquean las altas.
  const blockProvisional = env.APP_ENV === "production";
  const tokens = createOneTimeTokenService(db, clock);
  const services: Services = {
    env,
    db,
    clock,
    sessions,
    hasher,
    legal,
    tokens,
    cedulaStorage,
    templates: defaultTemplates,
    doctors: createDoctorService({ db, hasher, legal, cedulaStorage, clock, supportEmail: env.SUPPORT_EMAIL, blockProvisional }),
    doctorGuards: createDoctorGuards(db),
    support: createSupportService(db, clock),
    patients: createPatientRegistration({ db, hasher, legal, clock, blockProvisional }),
    dependents: createDependentsService({ db, legal, clock }),
    throttle,
    devices: createDeviceService(db, clock, env.SESSION_SECRET),
    reauth: createReauth(db, hasher, throttle),
    mfa: createMfaService(db, clock, env.MFA_ENCRYPTION_KEY),
    invitations: createInvitationService({ db, tokens, legal, hasher, clock, blockProvisional }),
    memberships: createMembershipService({ db, sessions, clock }),
    tenants: createTenantResolver(db),
  };

  // Garantiza que existan los textos legales (provisionales); en producción bloquean las altas hasta revisarse.
  await seedProvisionalDocuments(services.legal);

  const app = await buildApp({
    appEnv: env.APP_ENV,
    trustProxy: env.TRUST_PROXY,
    sessions: services.sessions,
    csrfSecret: env.SESSION_SECRET,
    legal,
    ...(options.logStream ? { logStream: options.logStream } : {}),
  });

  if (options.onRoute) {
    const onRoute = options.onRoute;
    app.addHook("onRoute", (route) => onRoute({ method: route.method, url: route.url }));
  }

  registerAuthRoutes(app, services);
  registerRecoveryRoutes(app, services);
  registerAccountRoutes(app, services);
  registerMfaRoutes(app, services);
  registerPatientDetailRoutes(app, services);
  registerDoctorAccountRoutes(app, services);
  registerDoctorRegistrationRoutes(app, services);
  registerDoctorStatusRoutes(app, services);
  registerPatientRoutes(app, services);
  registerReceptionRoutes(app, services);
  registerLegalRoutes(app, services);
  // Soporte aprueba cuentas y ve cédulas: exige sesión de soporte con doble factor verificado (ver support-mfa.ts).
  registerSupportRoutes(app, services);
  registerCalendarRoutes(app, services);

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
