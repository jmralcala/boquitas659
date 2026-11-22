import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { composeApp, type Services } from "../../../src/compose.js";
import { loadEnv, type Env } from "../../../src/config/env.js";
import type { Db } from "../../../src/db/pool.js";
import { sessionCsrfToken } from "../../../src/http/csrf.js";
import { SESSION_COOKIE } from "../../../src/http/session-plugin.js";
import { createFixedClock, type FixedClock } from "../../../src/lib/clock.js";
import { processOutbox, type OutboxResult } from "../../../src/mail/outbox.js";
import { createMemoryTransport, type MemoryTransport } from "../../../src/mail/transport.js";
import { createPasswordHasher } from "../../../src/modules/auth/password-hasher.js";
import { testDatabaseUrl, type CreatedUser } from "./db.js";

export const CSRF_SECRET = "s".repeat(40);

export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({
    APP_ENV: "development",
    PUBLIC_BASE_URL: "http://localhost:3000",
    DATABASE_URL: testDatabaseUrl(),
    SESSION_SECRET: CSRF_SECRET,
    MFA_ENCRYPTION_KEY: "b".repeat(64),
    CEDULA_STORAGE_DIR: mkdtempSync(join(tmpdir(), "boquitas-cedulas-")),
    PASSWORD_HASHER: "argon2",
    ...overrides,
  });
}

export interface TestApp {
  app: FastifyInstance;
  services: Services;
  transport: MemoryTransport;
  clock: FixedClock;
  /** Procesa el outbox (como haría el cron) con un transporte en memoria. */
  runOutbox(): Promise<OutboxResult>;
}

/** Aplicación completa sobre la base de pruebas, con reloj controlable y correo en memoria. */
export async function createTestApp(db: Db, overrides: Record<string, string> = {}): Promise<TestApp> {
  const clock = createFixedClock(new Date());
  const transport = createMemoryTransport();
  const { app, services } = await composeApp({
    env: testEnv(overrides),
    db,
    clock,
    hasher: createPasswordHasher("argon2", { argon2: { memoryCost: 1024, timeCost: 2, parallelism: 1 } }),
  });
  await app.ready();
  return {
    app,
    services,
    transport,
    clock,
    runOutbox: () =>
      processOutbox({
        db,
        transport,
        tokens: services.tokens,
        templates: services.templates,
        baseUrl: services.env.PUBLIC_BASE_URL,
        clock,
        maxAttempts: 3,
      }),
  };
}

let ipCounter = 0;

/**
 * Cada petición de prueba sale de una IP distinta para que el límite de peticiones por IP (que sí existe en la
 * aplicación) no interfiera entre pruebas. Las pruebas del propio límite pasan una IP fija.
 */
export function uniqueIp(): string {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

export interface AnonymousForm {
  cookie: string;
  token: string;
}

/** Abre un formulario sin sesión y devuelve la cookie y el token CSRF de doble envío. */
export async function anonymousForm(app: FastifyInstance, url: string): Promise<AnonymousForm> {
  const response = await app.inject({ method: "GET", url, remoteAddress: uniqueIp() });
  const cookie = response.cookies.find((c) => c.name === "__Host-csrf");
  const token = /name="_csrf" value="([^"]+)"/.exec(response.body)?.[1];
  if (!cookie || !token) throw new Error(`El formulario ${url} no entregó cookie y token CSRF (estado ${response.statusCode}).`);
  return { cookie: `__Host-csrf=${cookie.value}`, token };
}

export interface AuthedClient {
  cookie: string;
  csrf: string;
}

/** Crea una sesión completa para un usuario de fábrica y devuelve la cookie y su token CSRF. */
export async function sessionFor(services: Services, user: CreatedUser): Promise<AuthedClient> {
  const { token } = await services.sessions.create(user.id, { mfaVerified: true });
  const session = await services.sessions.validate(token);
  if (!session) throw new Error("No se pudo crear la sesión de prueba.");
  return { cookie: `${SESSION_COOKIE}=${token}`, csrf: sessionCsrfToken(CSRF_SECRET, session.csrfSecret) };
}

export function postForm(
  app: FastifyInstance,
  url: string,
  fields: Record<string, string>,
  cookie?: string,
  ip?: string,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url,
    remoteAddress: ip ?? uniqueIp(),
    headers: { ...(cookie ? { cookie } : {}), "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(fields).toString(),
  });
}

export interface UploadFile {
  field: string;
  filename: string;
  content: Buffer;
  contentType: string;
}

export function postMultipart(
  app: FastifyInstance,
  url: string,
  fields: Record<string, string>,
  files: UploadFile[],
  cookie?: string,
  ip?: string,
): Promise<LightMyRequestResponse> {
  const boundary = "----boquitas-test-boundary";
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, "utf8"),
    );
  }
  for (const file of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
        "utf8",
      ),
      file.content,
      Buffer.from("\r\n", "utf8"),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return app.inject({
    method: "POST",
    url,
    remoteAddress: ip ?? uniqueIp(),
    headers: { ...(cookie ? { cookie } : {}), "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(parts),
  });
}

/** Inicio de sesión por el formulario real (con CSRF). `extraCookies` permite enviar, por ejemplo, la cookie de dispositivo. */
export async function loginRequest(
  app: FastifyInstance,
  email: string,
  password: string,
  options: { ip?: string; extraCookies?: string } = {},
): Promise<LightMyRequestResponse> {
  const { cookie, token } = await anonymousForm(app, "/login");
  const cookies = options.extraCookies ? `${cookie}; ${options.extraCookies}` : cookie;
  return postForm(app, "/login", { email, password, _csrf: token }, cookies, options.ip);
}

/**
 * Procesa el outbox y devuelve el token del último enlace `pathPrefix/<token>` enviado a `to`
 * (los tokens nacen al enviar el correo y nunca se guardan en claro).
 */
export async function linkTokenSentTo(t: TestApp, to: string, pathPrefix: string): Promise<string> {
  await t.runOutbox();
  // Los prefijos de ruta usados solo llevan letras y barras; se escapan igualmente los metacaracteres.
  const escaped = pathPrefix.replace(/[.*+?^${}()|[\]\\]/g, (char) => `\\${char}`);
  const pattern = new RegExp(`${escaped}/([A-Za-z0-9_-]{43})`);
  const message = [...t.transport.sent].reverse().find((m) => m.to === to && pattern.test(m.text));
  const token = pattern.exec(message?.text ?? "")?.[1];
  if (!token) throw new Error(`No llegó un enlace ${pathPrefix} a ${to}.`);
  return token;
}

export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(128, 7)]);
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(128, 8)]);
export const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(128, 9)]);
