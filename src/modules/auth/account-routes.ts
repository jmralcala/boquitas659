import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RowDataPacket } from "mysql2/promise";
import { z } from "zod";
import type { Services } from "../../compose.js";
import { withTransaction } from "../../db/tx.js";
import { InvalidLinkError, TooManyAttemptsError, ValidationError, WrongPasswordError } from "../../http/errors.js";
import { parseInput } from "../../http/validate.js";
import { requireAuth } from "../../http/session-plugin.js";
import { errorList, form, passwordInput, submitButton, textInput } from "../../http/views/forms.js";
import { page } from "../../http/views/layout.js";
import { html, type SafeHtml } from "../../lib/html.js";
import { normalizeEmail } from "../../lib/normalize.js";
import { enqueueEmail } from "../../mail/outbox.js";
import { validatePassword } from "./password-policy.js";
import { recordSecurityEvent } from "./security-events.js";

type FieldErrors = Readonly<Record<string, readonly string[]>>;

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const required = "Este campo es obligatorio.";
const passwordBody = z.object({
  currentPassword: z.string({ error: required }).min(1, required).max(256),
  newPassword: z.string({ error: required }).min(1, required).max(256),
  newPasswordConfirm: z.string({ error: required }).min(1, required).max(256),
});
const emailBody = z.object({
  currentPassword: z.string({ error: required }).min(1, required).max(256),
  newEmail: z.string({ error: required }).trim().min(1, required).max(254),
});

// Mensaje genérico: no revela si el correo pertenece a otra cuenta ni de qué rol.
const EMAIL_UNAVAILABLE = "No pudimos usar ese correo. Prueba con otro.";

function send(reply: FastifyReply, status: number, title: string, content: SafeHtml): FastifyReply {
  return reply.code(status).type("text/html; charset=utf-8").send(page({ title, content }));
}

export function registerAccountRoutes(app: FastifyInstance, services: Services): void {
  function passwordPage(request: FastifyRequest, reply: FastifyReply, errors: FieldErrors = {}, done = false): SafeHtml {
    return html`<h1>Cambiar contraseña</h1>
${done ? html`<p role="status">Tu contraseña fue actualizada. Cerramos tus otras sesiones.</p>` : null}
${errorList(errors._)}
${form({
  action: "/cuenta/contrasena",
  csrf: app.csrf.tokenFor(request, reply),
  children: [
    passwordInput({ name: "currentPassword", label: "Contraseña actual", autocomplete: "current-password", required: true, errors: errors.currentPassword }),
    passwordInput({ name: "newPassword", label: "Contraseña nueva (mínimo 10 caracteres)", autocomplete: "new-password", required: true, errors: errors.newPassword }),
    passwordInput({ name: "newPasswordConfirm", label: "Repite la contraseña nueva", autocomplete: "new-password", required: true, errors: errors.newPasswordConfirm }),
    submitButton("Cambiar contraseña"),
  ],
})}`;
  }

  function emailPage(request: FastifyRequest, reply: FastifyReply, errors: FieldErrors = {}, sentTo?: string): SafeHtml {
    return html`<h1>Cambiar correo</h1>
${sentTo ? html`<p role="status">Te enviamos un enlace de confirmación a ${sentTo}. Tu correo de acceso sigue siendo el actual hasta que abras ese enlace (caduca en 60 minutos).</p>` : null}
${errorList(errors._)}
${form({
  action: "/cuenta/correo",
  csrf: app.csrf.tokenFor(request, reply),
  children: [
    passwordInput({ name: "currentPassword", label: "Contraseña actual", autocomplete: "current-password", required: true, errors: errors.currentPassword }),
    textInput({ name: "newEmail", label: "Correo nuevo", type: "email", autocomplete: "email", required: true, errors: errors.newEmail }),
    submitButton("Enviar enlace de confirmación"),
  ],
})}`;
  }

  app.get("/cuenta/contrasena", async (request, reply) => {
    requireAuth(request);
    return send(reply, 200, "Cambiar contraseña", passwordPage(request, reply));
  });

  app.post("/cuenta/contrasena", async (request, reply) => {
    const auth = requireAuth(request);
    try {
      const input = parseInput(passwordBody, request.body ?? {});
      // Primero se confirma la contraseña actual (comparte el control de intentos con el inicio de sesión).
      const user = await services.reauth.confirm(auth.userId, request.ip, input.currentPassword);

      const fields: Record<string, string[]> = {};
      const check = validatePassword(input.newPassword, { email: user.email });
      if (!check.ok) fields.newPassword = [check.message];
      if (input.newPassword !== input.newPasswordConfirm) fields.newPasswordConfirm = ["Las contraseñas no coinciden."];
      if (Object.keys(fields).length > 0) throw new ValidationError(fields);

      const passwordHash = await services.hasher.hash(input.newPassword);
      await withTransaction(services.db, async (connection) => {
        await connection.execute("UPDATE `user` SET password_hash = ?, password_changed_at = ? WHERE id = ?", [
          passwordHash,
          services.clock.now(),
          user.id,
        ]);
        await recordSecurityEvent(connection, services.clock, user.id, "password_changed");
        await enqueueEmail(connection, { template: "password_changed", to: user.email, payload: { userId: user.id } }, services.clock);
        // Se cierran las demás sesiones (y se conserva la actual) dentro de la misma transacción.
        await services.sessions.revokeAllForUser(user.id, auth.sessionId, connection);
      });
      return send(reply, 200, "Cambiar contraseña", passwordPage(request, reply, {}, true));
    } catch (error) {
      if (error instanceof WrongPasswordError || error instanceof ValidationError) {
        return send(reply, error.status, "Cambiar contraseña", passwordPage(request, reply, error.fields ?? {}));
      }
      throw error;
    }
  });

  app.get("/cuenta/correo", async (request, reply) => {
    requireAuth(request);
    return send(reply, 200, "Cambiar correo", emailPage(request, reply));
  });

  // Paso 1: se pide el cambio. El correo de acceso NO cambia: el nuevo queda pendiente hasta que esa dirección lo confirme.
  app.post("/cuenta/correo", async (request, reply) => {
    const auth = requireAuth(request);
    try {
      const input = parseInput(emailBody, request.body ?? {});
      const user = await services.reauth.confirm(auth.userId, request.ip, input.currentPassword);

      const newEmail = normalizeEmail(input.newEmail);
      if (newEmail === null) throw new ValidationError({ newEmail: ["Escribe un correo válido."] });
      if (newEmail === user.email.toLowerCase()) throw new ValidationError({ newEmail: ["Ese ya es el correo de tu cuenta."] });

      // Máximo 5 solicitudes por hora y usuario: este formulario envía un correo a cualquier dirección que se escriba.
      const [recent] = await services.db.execute<RowDataPacket[]>(
        "SELECT COUNT(*) AS n FROM security_event WHERE user_id = ? AND type = 'email_change_requested' AND occurred_at > ?",
        [user.id, new Date(services.clock.now().getTime() - 60 * 60_000)],
      );
      if (Number(recent[0]?.n) >= 5) throw new TooManyAttemptsError(15 * 60_000);

      // No se comprueba aquí si otra cuenta ya usa ese correo (no se revela): se resuelve al confirmar.
      await withTransaction(services.db, async (connection) => {
        await connection.execute("UPDATE `user` SET pending_email = ?, pending_email_normalized = ? WHERE id = ?", [newEmail, newEmail, user.id]);
        // Un enlace anterior ya no puede aplicar el correo nuevo que se acaba de pedir.
        await connection.execute(
          "UPDATE one_time_token SET used_at = ? WHERE user_id = ? AND purpose = 'email_change' AND used_at IS NULL",
          [services.clock.now(), user.id],
        );
        await recordSecurityEvent(connection, services.clock, user.id, "email_change_requested");
        // El token del enlace nace al enviar el correo (outbox); pedir otro cambio invalida el enlace anterior.
        await enqueueEmail(connection, { template: "email_change_confirm", to: newEmail, payload: { userId: user.id, newEmail } }, services.clock);
        await enqueueEmail(connection, { template: "email_change_requested", to: user.email, payload: { userId: user.id } }, services.clock);
      });
      return send(reply, 200, "Cambiar correo", emailPage(request, reply, {}, newEmail));
    } catch (error) {
      if (error instanceof WrongPasswordError || error instanceof ValidationError) {
        return send(reply, error.status, "Cambiar correo", emailPage(request, reply, error.fields ?? {}));
      }
      throw error;
    }
  });

  // Paso 2: el enlace llega al correo NUEVO. Abrirlo no cambia nada; el cambio ocurre al pulsar el botón.
  function invalidEmailLink(reply: FastifyReply): FastifyReply {
    return send(
      reply,
      410,
      "Enlace vencido",
      html`<h1>El enlace venció</h1><p>El enlace de confirmación venció o ya se usó. Si aún quieres cambiar tu correo, <a href="/cuenta/correo">pídelo de nuevo</a>.</p>`,
    );
  }

  async function pendingEmailOf(token: string): Promise<string | null> {
    if (!TOKEN.test(token)) return null;
    const subject = await services.tokens.peek(token, "email_change");
    if (subject?.userId == null) return null;
    const [rows] = await services.db.execute<RowDataPacket[]>("SELECT pending_email FROM `user` WHERE id = ?", [subject.userId]);
    return rows[0]?.pending_email ? String(rows[0].pending_email) : null;
  }

  app.get("/cuenta/correo/confirmar/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    const pending = await pendingEmailOf(token);
    if (pending === null) return invalidEmailLink(reply);
    return send(
      reply,
      200,
      "Confirmar correo",
      html`<h1>Confirmar tu correo nuevo</h1>
<p>Vas a usar <strong>${pending}</strong> como el correo de tu cuenta. Después tendrás que iniciar sesión de nuevo con él.</p>
${form({ action: `/cuenta/correo/confirmar/${token}`, csrf: app.csrf.tokenFor(request, reply), children: [submitButton("Confirmar correo")] })}`,
    );
  });

  app.post(
    "/cuenta/correo/confirmar/:token",
    { config: { rateLimit: { max: 20, timeWindow: "1 hour" } } },
    async (request, reply) => {
      const { token } = request.params as { token: string };
      if (!TOKEN.test(token)) return invalidEmailLink(reply);
      try {
        await withTransaction(services.db, async (connection) => {
          // Se consume dentro de la transacción: si falla algo el enlace sigue vigente; con envíos simultáneos solo uno gana.
          const subject = await services.tokens.consume(token, "email_change", connection);
          if (subject?.userId == null) throw new InvalidLinkError();
          const [rows] = await connection.execute<RowDataPacket[]>(
            "SELECT id, email, pending_email, pending_email_normalized FROM `user` WHERE id = ? FOR UPDATE",
            [subject.userId],
          );
          const user = rows[0];
          if (!user?.pending_email_normalized) throw new InvalidLinkError();

          const oldEmail = String(user.email);
          const newEmail = String(user.pending_email_normalized);
          await connection.execute(
            "UPDATE `user` SET email = ?, email_normalized = ?, pending_email = NULL, pending_email_normalized = NULL WHERE id = ?",
            [newEmail, newEmail, subject.userId],
          );
          // El paciente propio de la cuenta comparte el correo de acceso.
          await connection.execute(
            `UPDATE patient p JOIN patient_account a ON a.id = p.account_id
                SET p.email = ? WHERE a.user_id = ? AND p.is_minor_dependent = 0`,
            [newEmail, subject.userId],
          );
          await recordSecurityEvent(connection, services.clock, subject.userId, "email_changed");
          await enqueueEmail(connection, { template: "email_changed_old", to: oldEmail, payload: { userId: subject.userId } }, services.clock);
          await enqueueEmail(connection, { template: "email_changed_new", to: newEmail, payload: { userId: subject.userId } }, services.clock);
          // La identidad de acceso cambió: se cierran TODAS las sesiones, dentro de la misma transacción.
          await services.sessions.revokeAllForUser(subject.userId, undefined, connection);
        });
        return reply.redirect("/login", 303);
      } catch (error) {
        if (error instanceof InvalidLinkError) return invalidEmailLink(reply);
        if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
          return send(reply, 400, "Confirmar correo", html`<h1>No pudimos usar ese correo</h1><p>${EMAIL_UNAVAILABLE} <a href="/cuenta/correo">Elegir otro correo</a></p>`);
        }
        throw error;
      }
    },
  );
}
