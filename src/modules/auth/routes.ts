import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RowDataPacket } from "mysql2/promise";
import { z } from "zod";
import type { Db } from "../../db/pool.js";
import { clearSessionCookie, isFullyAuthenticated, setSessionCookie } from "../../http/session-plugin.js";
import { errorList, form, passwordInput, submitButton, textInput } from "../../http/views/forms.js";
import { page } from "../../http/views/layout.js";
import { html } from "../../lib/html.js";
import { normalizeEmail } from "../../lib/normalize.js";
import type { PasswordHasher } from "./password-hasher.js";
import type { SessionService, UserRole } from "./sessions.js";

export interface AuthRoutesDeps {
  db: Db;
  sessions: SessionService;
  hasher: PasswordHasher;
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
      const { password } = parsed.data;
      const email = normalizeEmail(parsed.data.email);

      let user: RowDataPacket | undefined;
      if (email !== null) {
        const [rows] = await deps.db.execute<RowDataPacket[]>(
          "SELECT id, role, password_hash, status, mfa_enabled FROM `user` WHERE email_normalized = ?",
          [email],
        );
        user = rows[0];
      }

      // Se hace siempre el mismo trabajo de hash, exista o no la cuenta, para no revelar cuáles correos existen.
      const passwordOk = user ? await deps.hasher.verify(String(user.password_hash), password) : await deps.hasher.dummyVerify(password);
      if (!user || !passwordOk || user.status !== "active") {
        return reply
          .code(401)
          .type("text/html; charset=utf-8")
          .send(renderLogin(app, request, reply, { email: parsed.data.email.slice(0, 254), error: LOGIN_ERROR }));
      }

      if (deps.hasher.needsRehash(String(user.password_hash))) {
        await deps.db.execute("UPDATE `user` SET password_hash = ? WHERE id = ?", [
          await deps.hasher.hash(password),
          user.id,
        ]);
      }

      // Sesión nueva en cada inicio: se descarta la anterior (evita fijación de sesión).
      if (request.sessionToken) await deps.sessions.revoke(request.sessionToken);
      const mfaEnabled = user.mfa_enabled === 1;
      const { token } = await deps.sessions.create(Number(user.id), { mfaVerified: false });
      setSessionCookie(reply, token);
      return reply.redirect(mfaEnabled ? "/login/mfa" : HOME_BY_ROLE[user.role as UserRole], 303);
    },
  );

  app.post("/logout", async (request, reply) => {
    if (request.sessionToken) await deps.sessions.revoke(request.sessionToken);
    clearSessionCookie(reply);
    return reply.redirect("/login", 303);
  });
}

