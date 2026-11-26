import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../../db/pool.js";
import { clearSessionCookie, isFullyAuthenticated, setSessionCookie } from "../../http/session-plugin.js";
import { errorList, form, passwordInput, submitButton, textInput } from "../../http/views/forms.js";
import { page } from "../../http/views/layout.js";
import { html } from "../../lib/html.js";
import type { Clock } from "../../lib/clock.js";
import { DEVICE_COOKIE, setDeviceCookie, type DeviceService } from "./devices.js";
import type { LoginService } from "./login-service.js";
import type { LoginThrottle } from "./login-throttle.js";
import type { PasswordHasher } from "./password-hasher.js";
import type { SessionService, UserRole } from "./sessions.js";

export interface AuthRoutesDeps {
  db: Db;
  sessions: SessionService;
  hasher: PasswordHasher;
  throttle: LoginThrottle;
  devices: DeviceService;
  login: LoginService;
  clock?: Clock;
}

/** Página de inicio de cada rol tras iniciar sesión. */
export const HOME_BY_ROLE: Record<UserRole, string> = {
  patient: "/pacientes/panel",
  doctor: "/medicos/inicio",
  reception: "/recepcion/panel",
  support: "/soporte/medicos",
};

const LOGIN_ERROR = "Correo o contraseña incorrectos.";

const loginSchema = z.object({
  email: z.string().min(1).max(254),
  password: z.string().min(1).max(256),
});

function renderLogin(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  options: { email?: string; error?: string } = {},
): string {
  const token = app.csrf.tokenFor(request, reply);
  return page({
    title: "Iniciar sesión",
    content: html`<h1>Iniciar sesión</h1>
${errorList(options.error ? [options.error] : undefined)}
${form({
  action: "/login",
  csrf: token,
  children: [
    textInput({ name: "email", label: "Correo", type: "email", value: options.email, autocomplete: "username", required: true }),
    passwordInput({ name: "password", label: "Contraseña", autocomplete: "current-password", required: true }),
    submitButton("Entrar"),
  ],
})}
<p><a href="/recuperar">¿Olvidaste tu contraseña?</a></p>`,
    size: "narrow",
  });
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRoutesDeps): void {
  app.get("/login", async (request, reply) => {
    if (isFullyAuthenticated(request.auth)) {
      return reply.redirect(HOME_BY_ROLE[request.auth.role], 303);
    }
    return reply.type("text/html; charset=utf-8").send(renderLogin(app, request, reply));
  });

  app.post(
    "/login",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .type("text/html; charset=utf-8")
          .send(renderLogin(app, request, reply, { error: "Escribe tu correo y tu contraseña." }));
      }
      const outcome = await deps.login.authenticate({
        email: parsed.data.email,
        password: parsed.data.password,
        ip: request.ip,
        deviceCookie: request.cookies[DEVICE_COOKIE],
        currentSessionToken: request.sessionToken,
      });
      if (outcome.kind === "throttled") {
        const seconds = Math.max(1, Math.ceil(outcome.retryAfterMs / 1000));
        return reply
          .code(429)
          .header("retry-after", String(seconds))
          .type("text/html; charset=utf-8")
          .send(
            renderLogin(app, request, reply, {
              email: parsed.data.email.slice(0, 254),
              error: `Demasiados intentos. Espera ${seconds} segundos e inténtalo de nuevo.`,
            }),
          );
      }
      if (outcome.kind !== "success") {
        return reply
          .code(401)
          .type("text/html; charset=utf-8")
          .send(renderLogin(app, request, reply, { email: parsed.data.email.slice(0, 254), error: LOGIN_ERROR }));
      }
      setDeviceCookie(reply, outcome.deviceId);
      setSessionCookie(reply, outcome.sessionToken);
      return reply.redirect(outcome.mfaEnabled ? "/login/mfa" : HOME_BY_ROLE[outcome.role], 303);
    },
  );

  app.post("/logout", async (request, reply) => {
    if (request.sessionToken) await deps.sessions.revoke(request.sessionToken);
    clearSessionCookie(reply);
    return reply.redirect("/login", 303);
  });
}
