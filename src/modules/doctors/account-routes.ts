import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Services } from "../../compose.js";
import { withTransaction } from "../../db/tx.js";
import { ForbiddenError, ValidationError, WrongPasswordError } from "../../http/errors.js";
import { parseInput } from "../../http/validate.js";
import { requireAuth, requireRole } from "../../http/session-plugin.js";
import { errorList, form, passwordInput, submitButton, textInput } from "../../http/views/forms.js";
import { page } from "../../http/views/layout.js";
import { alert } from "../../http/views/ui.js";
import { html, type SafeHtml } from "../../lib/html.js";
import { normalizeMxPhone } from "../../lib/normalize.js";
import { enqueueEmail } from "../../mail/outbox.js";
import { recordSecurityEvent } from "../auth/security-events.js";
import { assertAccountAllows } from "../reception/tenant-resolver.js";
import { findDoctorByUserId } from "./doctor-repository.js";

type FieldErrors = Readonly<Record<string, readonly string[]>>;

const required = "Este campo es obligatorio.";
const bodySchema = z.object({
  currentPassword: z.string({ error: required }).min(1, required).max(256),
  emergencyMobile: z.string({ error: required }).trim().min(1, required).max(40),
});

const MOBILE_TAKEN = "Este móvil ya está registrado en otra cuenta. Escribe a soporte si se trata de un error.";

export function registerDoctorAccountRoutes(app: FastifyInstance, services: Services): void {
  function view(request: FastifyRequest, reply: FastifyReply, errors: FieldErrors = {}, done = false): SafeHtml {
    return html`<h1>Móvil de emergencias</h1>
<p>Es el número al que avisamos en una urgencia. Cambiarlo exige tu contraseña actual y se notifica a tu correo.</p>
${done ? alert("success", "Tu móvil de emergencias fue actualizado.") : null}
${errorList(errors._)}
${form({
  action: "/cuenta/movil-emergencia",
  csrf: app.csrf.tokenFor(request, reply),
  children: [
    passwordInput({ name: "currentPassword", label: "Contraseña actual", autocomplete: "current-password", required: true, errors: errors.currentPassword }),
    textInput({ name: "emergencyMobile", label: "Móvil de emergencias nuevo (10 dígitos)", type: "tel", autocomplete: "tel", required: true, errors: errors.emergencyMobile }),
    submitButton("Cambiar móvil"),
  ],
})}`;
  }

  function send(reply: FastifyReply, status: number, content: SafeHtml): FastifyReply {
    return reply.code(status).type("text/html; charset=utf-8").send(page({ title: "Móvil de emergencias", content }));
  }

  app.get("/cuenta/movil-emergencia", { preHandler: requireRole("doctor") }, async (request, reply) =>
    send(reply, 200, view(request, reply)),
  );

  app.post("/cuenta/movil-emergencia", { preHandler: requireRole("doctor") }, async (request, reply) => {
    const auth = requireAuth(request);
    try {
      const input = parseInput(bodySchema, request.body ?? {});
      const user = await services.reauth.confirm(auth.userId, request.ip, input.currentPassword);

      const mobile = normalizeMxPhone(input.emergencyMobile);
      if (mobile === null) throw new ValidationError({ emergencyMobile: ["Escribe un número de 10 dígitos."] });
      const doctor = await findDoctorByUserId(services.db, auth.userId);
      if (!doctor) throw new ForbiddenError();
      // Una cuenta en solo lectura (o suspendida) no cambia el móvil que ven los pacientes en las pantallas de emergencia.
      assertAccountAllows(doctor.accountState, request.method);
      if (doctor.emergencyMobile === mobile) {
        throw new ValidationError({ emergencyMobile: ["Ese ya es tu móvil de emergencias."] });
      }

      try {
        await withTransaction(services.db, async (connection) => {
          await connection.execute("UPDATE doctor SET emergency_mobile = ? WHERE id = ?", [mobile, doctor.id]);
          await recordSecurityEvent(connection, services.clock, user.id, "emergency_mobile_changed");
          await enqueueEmail(
            connection,
            { template: "emergency_mobile_changed", to: user.email, payload: { userId: user.id } },
            services.clock,
          );
        });
      } catch (error) {
        if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
          throw new ValidationError({ emergencyMobile: [MOBILE_TAKEN] });
        }
        throw error;
      }
      return send(reply, 200, view(request, reply, {}, true));
    } catch (error) {
      if (error instanceof WrongPasswordError || error instanceof ValidationError) {
        return send(reply, error.status, view(request, reply, error.fields ?? {}));
      }
      throw error;
    }
  });
}
