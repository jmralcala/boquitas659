import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Services } from "../../compose.js";
import { withTransaction } from "../../db/tx.js";
import { ValidationError, WrongPasswordError } from "../../http/errors.js";
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

  function emailPage(request: FastifyRequest, reply: FastifyReply, errors: FieldErrors = {}, done = false): SafeHtml {
    return html`<h1>Cambiar correo</h1>
${done ? html`<p role="status">Tu correo fue actualizado. Avisamos al correo anterior y al nuevo, y cerramos tus otras sesiones.</p>` : null}
${errorList(errors._)}
${form({
  action: "/cuenta/correo",
  csrf: app.csrf.tokenFor(request, reply),
  children: [
    passwordInput({ name: "currentPassword", label: "Contraseña actual", autocomplete: "current-password", required: true, errors: errors.currentPassword }),
    textInput({ name: "newEmail", label: "Correo nuevo", type: "email", autocomplete: "email", required: true, errors: errors.newEmail }),
    submitButton("Cambiar correo"),
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
      });
      // Se cierran las demás sesiones y se conserva la actual.
      await services.sessions.revokeAllForUser(user.id, auth.sessionId);
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

  app.post("/cuenta/correo", async (request, reply) => {
    const auth = requireAuth(request);
    try {
      const input = parseInput(emailBody, request.body ?? {});
      const user = await services.reauth.confirm(auth.userId, request.ip, input.currentPassword);

      const newEmail = normalizeEmail(input.newEmail);
      if (newEmail === null) throw new ValidationError({ newEmail: ["Escribe un correo válido."] });
      if (newEmail === user.email.toLowerCase()) throw new ValidationError({ newEmail: ["Ese ya es el correo de tu cuenta."] });

      try {
        await withTransaction(services.db, async (connection) => {
          await connection.execute("UPDATE `user` SET email = ?, email_normalized = ? WHERE id = ?", [newEmail, newEmail, user.id]);
          // El paciente propio de la cuenta comparte el correo de acceso.
          await connection.execute(
            `UPDATE patient p JOIN patient_account a ON a.id = p.account_id
                SET p.email = ? WHERE a.user_id = ? AND p.is_minor_dependent = 0`,
            [newEmail, user.id],
          );
          await recordSecurityEvent(connection, services.clock, user.id, "email_changed");
          await enqueueEmail(connection, { template: "email_changed_old", to: user.email, payload: { userId: user.id } }, services.clock);
          await enqueueEmail(connection, { template: "email_changed_new", to: newEmail, payload: { userId: user.id } }, services.clock);
        });
      } catch (error) {
        // Mensaje genérico: no revela si el correo pertenece a otra cuenta ni de qué rol.
        if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
          throw new ValidationError({ newEmail: ["No pudimos usar ese correo. Prueba con otro."] });
        }
        throw error;
      }
      await services.sessions.revokeAllForUser(user.id, auth.sessionId);
      return send(reply, 200, "Cambiar correo", emailPage(request, reply, {}, true));
    } catch (error) {
      if (error instanceof WrongPasswordError || error instanceof ValidationError) {
        return send(reply, error.status, "Cambiar correo", emailPage(request, reply, error.fields ?? {}));
      }
      throw error;
    }
  });
}
