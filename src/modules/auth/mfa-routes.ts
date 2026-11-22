import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RowDataPacket } from "mysql2/promise";
import { z } from "zod";
import type { Services } from "../../compose.js";
import { AppError, ForbiddenError, WrongPasswordError } from "../../http/errors.js";
import { parseInput } from "../../http/validate.js";
import { requireAuth, requireRole, setSessionCookie } from "../../http/session-plugin.js";
import { errorList, form, passwordInput, submitButton, textInput } from "../../http/views/forms.js";
import { page } from "../../http/views/layout.js";
import { html, type SafeHtml } from "../../lib/html.js";
import { enqueueEmail } from "../../mail/outbox.js";
import { HOME_BY_ROLE } from "./routes.js";
import { recordSecurityEvent } from "./security-events.js";

const required = "Este campo es obligatorio.";
const codeBody = z.object({ code: z.string({ error: required }).trim().min(1, required).max(40) });
const passwordBody = z.object({ currentPassword: z.string({ error: required }).min(1, required).max(256) });

function send(reply: FastifyReply, status: number, title: string, content: SafeHtml): FastifyReply {
  return reply.code(status).type("text/html; charset=utf-8").send(page({ title, content }));
}

export function registerMfaRoutes(app: FastifyInstance, services: Services): void {
  // El doble factor es opcional para médicos y recepción y obligatorio para soporte. Los pacientes no lo usan.
  const mfaRoles = requireRole("doctor", "reception", "support");

  // --- Segundo paso del inicio de sesión -------------------------------------------------------------------

  function codeForm(request: FastifyRequest, reply: FastifyReply, error?: string): SafeHtml {
    return html`<h1>Verificación en dos pasos</h1>
<p>Escribe el código de 6 dígitos de tu aplicación de autenticación, o uno de tus códigos de recuperación.</p>
${errorList(error ? [error] : undefined)}
${form({
  action: "/login/mfa",
  csrf: app.csrf.tokenFor(request, reply),
  children: [textInput({ name: "code", label: "Código", autocomplete: "one-time-code", required: true }), submitButton("Verificar")],
})}`;
  }

  /** Sesión a medias: contraseña correcta, segundo factor pendiente. */
  function partialSession(request: FastifyRequest) {
    const auth = request.auth;
    return auth && auth.mfaEnabled && !auth.mfaVerified ? auth : null;
  }

  app.get("/login/mfa", async (request, reply) => {
    if (!partialSession(request)) return reply.redirect(request.auth ? HOME_BY_ROLE[request.auth.role] : "/login", 303);
    return send(reply, 200, "Verificación en dos pasos", codeForm(request, reply));
  });

  app.post("/login/mfa", { config: { rateLimit: { max: 30, timeWindow: "1 hour" } } }, async (request, reply) => {
    const auth = partialSession(request);
    if (!auth) return reply.redirect(request.auth ? HOME_BY_ROLE[request.auth.role] : "/login", 303);

    const { code } = parseInput(codeBody, request.body ?? {});
    const [rows] = await services.db.execute<RowDataPacket[]>("SELECT email FROM `user` WHERE id = ?", [auth.userId]);
    const key = services.throttle.accountKey(String(rows[0]?.email ?? ""));

    // Mismo control de intentos que la contraseña: cada código incorrecto aumenta la espera.
    const gate = await services.throttle.check(key, request.ip);
    if (!gate.allowed) {
      const seconds = Math.max(1, Math.ceil(gate.retryAfterMs / 1000));
      void reply.header("retry-after", String(seconds));
      return send(reply, 429, "Verificación en dos pasos", codeForm(request, reply, `Demasiados intentos. Espera ${seconds} segundos e inténtalo de nuevo.`));
    }
    if (!(await services.mfa.verifyLogin(auth.userId, code))) {
      await services.throttle.recordFailure(key, request.ip);
      return send(reply, 401, "Verificación en dos pasos", codeForm(request, reply, "El código no es correcto."));
    }
    await services.throttle.recordSuccess(key);

    // Al subir de privilegio se cambia el token de la sesión: el anterior (a medias) deja de servir.
    const { token } = await services.sessions.rotate(auth.sessionId, { mfaVerified: true });
    setSessionCookie(reply, token);
    return reply.redirect(HOME_BY_ROLE[auth.role], 303);
  });

  // --- Gestión del doble factor en la cuenta --------------------------------------------------------------

  function statusPage(request: FastifyRequest, reply: FastifyReply, enabled: boolean, role: string, error?: string): SafeHtml {
    const csrf = app.csrf.tokenFor(request, reply);
    return html`<h1>Doble factor de autenticación</h1>
${errorList(error ? [error] : undefined)}
${
  enabled
    ? html`<p role="status">El doble factor está <strong>activo</strong>.</p>
${role === "support" ? html`<p>Es obligatorio para soporte y no se puede desactivar.</p>` : form({ action: "/cuenta/mfa/desactivar", csrf, children: [passwordInput({ name: "currentPassword", label: "Contraseña actual", autocomplete: "current-password", required: true }), submitButton("Desactivar doble factor")] })}`
    : html`<p>${role === "support" ? "Para usar el panel de soporte debes activar el doble factor." : "Añade una capa extra de seguridad a tu cuenta con una aplicación de autenticación."}</p>
${form({ action: "/cuenta/mfa/activar", csrf, children: [passwordInput({ name: "currentPassword", label: "Contraseña actual", autocomplete: "current-password", required: true }), submitButton("Activar doble factor")] })}`
}`;
  }

  async function renderStatus(request: FastifyRequest, reply: FastifyReply, status = 200, error?: string): Promise<FastifyReply> {
    const auth = requireAuth(request);
    const enabled = await services.mfa.isEnabled(auth.userId);
    return send(reply, status, "Doble factor", statusPage(request, reply, enabled, auth.role, error));
  }

  function enrollmentPage(request: FastifyRequest, reply: FastifyReply, enrollment: { secret: string; otpauthUri: string }, error?: string): SafeHtml {
    return html`<h1>Configura tu aplicación de autenticación</h1>
<p>En tu aplicación (Google Authenticator, Authy, 1Password…) añade una cuenta nueva con esta clave:</p>
<p><code id="mfa-secret">${enrollment.secret}</code></p>
<p>O abre este enlace desde el dispositivo donde está la aplicación: <a href="${enrollment.otpauthUri}">${enrollment.otpauthUri}</a></p>
<p>Después escribe el código de 6 dígitos que muestre para confirmar.</p>
${errorList(error ? [error] : undefined)}
${form({
  action: "/cuenta/mfa/confirmar",
  csrf: app.csrf.tokenFor(request, reply),
  children: [textInput({ name: "code", label: "Código de 6 dígitos", autocomplete: "one-time-code", required: true }), submitButton("Confirmar y activar")],
})}`;
  }

  app.get("/cuenta/mfa", { preHandler: mfaRoles }, async (request, reply) => renderStatus(request, reply));
  // Pantalla de alta: es la única a la que soporte llega mientras no active el doble factor.
  app.get("/cuenta/mfa/alta", { preHandler: mfaRoles }, async (request, reply) => renderStatus(request, reply));

  app.post("/cuenta/mfa/activar", { preHandler: mfaRoles }, async (request, reply) => {
    const auth = requireAuth(request);
    try {
      const { currentPassword } = parseInput(passwordBody, request.body ?? {});
      await services.reauth.confirm(auth.userId, request.ip, currentPassword);
      const enrollment = await services.mfa.beginEnrollment(auth.userId);
      return send(reply, 200, "Activar doble factor", enrollmentPage(request, reply, enrollment));
    } catch (error) {
      if (error instanceof WrongPasswordError) return renderStatus(request, reply, 403, error.publicMessage);
      if (error instanceof AppError && error.code === "mfa_already_enabled") return renderStatus(request, reply, 409, error.publicMessage);
      throw error;
    }
  });

  app.post("/cuenta/mfa/confirmar", { preHandler: mfaRoles }, async (request, reply) => {
    const auth = requireAuth(request);
    const { code } = parseInput(codeBody, request.body ?? {});
    const confirmed = await services.mfa.confirmEnrollment(auth.userId, code).catch((error: unknown) => {
      if (error instanceof AppError && error.code === "mfa_already_enabled") return "already" as const;
      throw error;
    });
    if (confirmed === "already") return renderStatus(request, reply, 409, "El doble factor ya está activo.");
    if (confirmed === null) {
      const pending = await services.mfa.pendingEnrollment(auth.userId);
      if (!pending) return renderStatus(request, reply, 400, "Primero genera tu clave con «Activar doble factor».");
      return send(reply, 400, "Activar doble factor", enrollmentPage(request, reply, pending, "El código no es correcto. Inténtalo de nuevo."));
    }

    const [rows] = await services.db.execute<RowDataPacket[]>("SELECT email FROM `user` WHERE id = ?", [auth.userId]);
    await recordSecurityEvent(services.db, services.clock, auth.userId, "mfa_enabled");
    await enqueueEmail(services.db, { template: "mfa_enabled", to: String(rows[0]?.email), payload: { userId: auth.userId } }, services.clock);

    // La sesión que activó el doble factor sigue válida: se rota ya verificada.
    const { token } = await services.sessions.rotate(auth.sessionId, { mfaVerified: true });
    setSessionCookie(reply, token);
    const codes = confirmed.recoveryCodes.map((recovery) => html`<li><code class="recovery-code">${recovery}</code></li>`);
    return send(
      reply,
      200,
      "Doble factor activo",
      html`<h1>Doble factor activado</h1>
<p><strong>Guarda estos códigos de recuperación ahora.</strong> No se volverán a mostrar. Cada uno sirve una sola vez si pierdes tu aplicación.</p>
<ul>${codes}</ul>
<p><a href="${HOME_BY_ROLE[auth.role]}">Continuar</a></p>`,
    );
  });

  app.post("/cuenta/mfa/desactivar", { preHandler: mfaRoles }, async (request, reply) => {
    const auth = requireAuth(request);
    // Soporte no puede desactivarlo: es obligatorio.
    if (auth.role === "support") throw new ForbiddenError("El doble factor es obligatorio para soporte.");
    try {
      const { currentPassword } = parseInput(passwordBody, request.body ?? {});
      const user = await services.reauth.confirm(auth.userId, request.ip, currentPassword);
      await services.mfa.disable(auth.userId);
      await recordSecurityEvent(services.db, services.clock, auth.userId, "mfa_disabled");
      await enqueueEmail(services.db, { template: "mfa_disabled", to: user.email, payload: { userId: auth.userId } }, services.clock);
      return send(reply, 200, "Doble factor", html`<h1>Doble factor desactivado</h1><p role="status">Desactivaste el doble factor. Puedes volver a activarlo cuando quieras.</p>`);
    } catch (error) {
      if (error instanceof WrongPasswordError) return renderStatus(request, reply, 403, error.publicMessage);
      throw error;
    }
  });
}
