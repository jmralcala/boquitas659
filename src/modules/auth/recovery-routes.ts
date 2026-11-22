import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RowDataPacket } from "mysql2/promise";
import { z } from "zod";
import type { Services } from "../../compose.js";
import { withTransaction } from "../../db/tx.js";
import { InvalidLinkError, ValidationError } from "../../http/errors.js";
import { parseInput } from "../../http/validate.js";
import { errorList, form, passwordInput, submitButton, textInput } from "../../http/views/forms.js";
import { page } from "../../http/views/layout.js";
import { html } from "../../lib/html.js";
import { normalizeEmail } from "../../lib/normalize.js";
import { enqueueEmail } from "../../mail/outbox.js";
import { validatePassword } from "./password-policy.js";
import { recordSecurityEvent } from "./security-events.js";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const requestSchema = z.object({ email: z.string().max(254).default("") });
const resetSchema = z.object({
  password: z.string({ error: "Este campo es obligatorio." }).min(1, "Este campo es obligatorio.").max(256),
  passwordConfirm: z.string({ error: "Este campo es obligatorio." }).min(1, "Este campo es obligatorio.").max(256),
});

function sendPage(reply: FastifyReply, status: number, content: ReturnType<typeof html>, title: string): FastifyReply {
  return reply.code(status).type("text/html; charset=utf-8").send(page({ title, content }));
}

function requestForm(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply, email = ""): ReturnType<typeof html> {
  return html`<h1>Recuperar contraseña</h1>
<p>Escribe el correo de tu cuenta y te enviaremos un enlace para elegir una contraseña nueva.</p>
${form({
  action: "/recuperar",
  csrf: app.csrf.tokenFor(request, reply),
  children: [textInput({ name: "email", label: "Correo", type: "email", value: email, autocomplete: "username", required: true }), submitButton("Enviar enlace")],
})}
<p><a href="/login">Volver a iniciar sesión</a></p>`;
}

function invalidLink(reply: FastifyReply): FastifyReply {
  return sendPage(
    reply,
    410,
    html`<h1>El enlace venció</h1><p>El enlace de recuperación venció o ya se usó. <a href="/recuperar">Pide uno nuevo</a>.</p>`,
    "Enlace vencido",
  );
}

export function registerRecoveryRoutes(app: FastifyInstance, services: Services): void {
  app.get("/recuperar", async (request, reply) => sendPage(reply, 200, requestForm(app, request, reply), "Recuperar contraseña"));

  app.post("/recuperar", { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } }, async (request, reply) => {
    const { email: raw } = parseInput(requestSchema, request.body ?? {});
    const email = normalizeEmail(raw);
    if (email !== null) {
      const [rows] = await services.db.execute<RowDataPacket[]>(
        "SELECT id, email, status FROM `user` WHERE email_normalized = ?",
        [email],
      );
      const user = rows[0];
      if (user && user.status === "active") {
        // El token se crea al enviar el correo (outbox), nunca se guarda en claro.
        await enqueueEmail(
          services.db,
          { template: "password_reset", to: String(user.email), payload: { userId: Number(user.id) } },
          services.clock,
        );
      }
    }
    // Misma respuesta exista o no la cuenta.
    return sendPage(
      reply,
      200,
      html`<h1>Revisa tu correo</h1><p>Si el correo está registrado, te enviamos un enlace para elegir una contraseña nueva. El enlace caduca en 30 minutos.</p><p><a href="/login">Volver a iniciar sesión</a></p>`,
      "Revisa tu correo",
    );
  });

  function resetForm(
    request: FastifyRequest,
    reply: FastifyReply,
    token: string,
    errors: Readonly<Record<string, readonly string[]>> = {},
  ): ReturnType<typeof html> {
    return html`<h1>Elige una contraseña nueva</h1>
${errorList(errors._)}
${form({
  action: `/recuperar/${token}`,
  csrf: app.csrf.tokenFor(request, reply),
  children: [
    passwordInput({ name: "password", label: "Contraseña nueva (mínimo 10 caracteres)", autocomplete: "new-password", required: true, errors: errors.password }),
    passwordInput({ name: "passwordConfirm", label: "Repite la contraseña", autocomplete: "new-password", required: true, errors: errors.passwordConfirm }),
    submitButton("Cambiar contraseña"),
  ],
})}`;
  }

  // Abrir el enlace nunca lo consume: antivirus y clientes de correo abren los enlaces automáticamente.
  app.get("/recuperar/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    if (!TOKEN.test(token) || (await services.tokens.peek(token, "password_reset")) === null) return invalidLink(reply);
    return sendPage(reply, 200, resetForm(request, reply, token), "Contraseña nueva");
  });

  app.post("/recuperar/:token", { config: { rateLimit: { max: 20, timeWindow: "1 hour" } } }, async (request, reply) => {
    const { token } = request.params as { token: string };
    if (!TOKEN.test(token)) return invalidLink(reply);
    const subject = await services.tokens.peek(token, "password_reset");
    if (subject?.userId == null) return invalidLink(reply);
    const userId = subject.userId;

    const [rows] = await services.db.execute<RowDataPacket[]>("SELECT email, status FROM `user` WHERE id = ?", [userId]);
    const user = rows[0];
    if (!user || user.status !== "active") return invalidLink(reply);

    try {
      const input = parseInput(resetSchema, request.body ?? {});
      const fields: Record<string, string[]> = {};
      const check = validatePassword(input.password, { email: String(user.email) });
      if (!check.ok) fields.password = [check.message];
      if (input.password !== input.passwordConfirm) fields.passwordConfirm = ["Las contraseñas no coinciden."];
      if (Object.keys(fields).length > 0) throw new ValidationError(fields);

      const passwordHash = await services.hasher.hash(input.password);
      await withTransaction(services.db, async (connection) => {
        // Se consume dentro de la transacción: si algo falla, el enlace sigue vigente; con envíos simultáneos solo uno gana.
        if ((await services.tokens.consume(token, "password_reset", connection)) === null) throw new InvalidLinkError();
        const now = services.clock.now();
        await connection.execute("UPDATE `user` SET password_hash = ?, password_changed_at = ? WHERE id = ?", [
          passwordHash,
          now,
          userId,
        ]);
        await recordSecurityEvent(connection, services.clock, userId, "password_reset");
        await enqueueEmail(connection, { template: "password_changed", to: String(user.email), payload: { userId } }, services.clock);
      });
      // Cambiar la contraseña cierra todas las sesiones (también la de quien pudiera tener acceso indebido).
      await services.sessions.revokeAllForUser(userId);
      return reply.redirect("/login", 303);
    } catch (error) {
      if (error instanceof InvalidLinkError) return invalidLink(reply);
      if (error instanceof ValidationError) {
        return sendPage(reply, 400, resetForm(request, reply, token, error.fields ?? {}), "Contraseña nueva");
      }
      throw error;
    }
  });
}
