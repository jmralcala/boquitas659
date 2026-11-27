import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Services } from "../../compose.js";
import { ValidationError } from "../../http/errors.js";
import { wantsJson } from "../../http/negotiation.js";
import { requireAuth } from "../../http/session-plugin.js";
import { errorList, fileInput, form, submitButton, textInput } from "../../http/views/forms.js";
import { page } from "../../http/views/layout.js";
import { alert, badgeOf, doctorApprovalBadge } from "../../http/views/ui.js";
import { html, type SafeHtml } from "../../lib/html.js";
import type { Doctor } from "./doctor-repository.js";
import { CEDULA_HINT, ID_HINT } from "./registration-routes.js";

type FieldErrors = Readonly<Record<string, readonly string[]>>;

function text(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value.slice(0, 300) : "";
}

function statusView(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  doctor: Doctor,
  options: { values?: Record<string, unknown>; errors?: FieldErrors } = {},
): string {
  const errors = options.errors ?? {};
  const values = options.values ?? {};
  let body: SafeHtml;
  if (doctor.approvalStatus === "pending") {
    body = html`<p>${badgeOf(doctorApprovalBadge("pending"))}</p>${alert("info", "Tu solicitud está en revisión. Te avisaremos por correo cuando soporte la resuelva.")}`;
  } else if (doctor.approvalStatus === "approved") {
    body = html`<p>${badgeOf(doctorApprovalBadge("approved"))}</p>${alert("success", html`Tu cuenta está aprobada. <a href="/medicos/panel">Ir a mi panel</a>`)}`;
  } else {
    const needsCedula = doctor.cedulaNormalized === null;
    const needsMobile = doctor.emergencyMobile === null;
    body = html`<p>${badgeOf(doctorApprovalBadge("rejected"))}</p>${alert("error", html`<p>Tu solicitud necesita correcciones.</p><p><strong>Motivo:</strong> ${doctor.rejectionReason ?? "Sin motivo indicado."}</p>`)}
${errorList(errors._)}
${form({
  action: "/medicos/estado/reenviar",
  csrf: app.csrf.tokenFor(request, reply),
  multipart: true,
  children: [
    textInput({
      name: "cedulaNumber",
      label: needsCedula ? "Cédula profesional" : "Cédula profesional (déjala vacía para conservar la actual)",
      value: text(values, "cedulaNumber"),
      errors: errors.cedulaNumber,
    }),
    textInput({
      name: "emergencyMobile",
      label: needsMobile ? "Móvil de emergencias (10 dígitos)" : "Móvil de emergencias (déjalo vacío para conservar el actual)",
      type: "tel",
      value: text(values, "emergencyMobile"),
      errors: errors.emergencyMobile,
    }),
    fileInput({ name: "cedulaFile", label: "Foto o PDF de tu cédula (máximo 5 MB)", accept: "image/jpeg,image/png,application/pdf", errors: errors.cedulaFile, hint: CEDULA_HINT }),
    fileInput({
      name: "idFile",
      label: doctor.idFilePath === null ? "Foto o PDF de tu identificación oficial (máximo 5 MB)" : "Foto o PDF de tu identificación oficial (déjala vacía para conservar la actual)",
      accept: "image/jpeg,image/png,application/pdf",
      errors: errors.idFile,
      hint: ID_HINT,
    }),
    submitButton("Reenviar solicitud"),
  ],
})}`;
  }
  return page({ title: "Estado de tu solicitud", content: html`<h1>Estado de tu solicitud</h1>${body}` });
}

export function registerDoctorStatusRoutes(app: FastifyInstance, services: Services): void {
  const { requireDoctorAccount, requireApprovedDoctor, loadDoctor } = services.doctorGuards;

  // Punto de entrada del rol: aprobado va al panel, el resto a la pantalla de estado.
  app.get("/medicos/inicio", { preHandler: requireDoctorAccount }, async (request, reply) => {
    const doctor = await loadDoctor(request);
    return reply.redirect(doctor.approvalStatus === "approved" ? "/medicos/panel" : "/medicos/estado", 303);
  });

  app.get("/medicos/estado", { preHandler: requireDoctorAccount }, async (request, reply) => {
    const doctor = await loadDoctor(request);
    if (wantsJson(request)) {
      return reply.send({ status: doctor.approvalStatus, reason: doctor.rejectionReason });
    }
    return reply.type("text/html; charset=utf-8").send(statusView(app, request, reply, doctor));
  });

  app.post(
    "/medicos/estado/reenviar",
    { preHandler: requireDoctorAccount, config: { rateLimit: { max: 10, timeWindow: "1 hour" } } },
    async (request, reply) => {
      const auth = requireAuth(request);
      const body = (request.body ?? {}) as Record<string, unknown>;
      try {
        await services.doctors.resubmit(auth.userId, {
          cedulaNumber: typeof body.cedulaNumber === "string" ? body.cedulaNumber : undefined,
          emergencyMobile: typeof body.emergencyMobile === "string" ? body.emergencyMobile : undefined,
          cedulaFile: Buffer.isBuffer(body.cedulaFile) ? body.cedulaFile : undefined,
          idFile: Buffer.isBuffer(body.idFile) ? body.idFile : undefined,
        });
        return reply.redirect("/medicos/estado", 303);
      } catch (error) {
        if (error instanceof ValidationError) {
          const doctor = await loadDoctor(request);
          return reply
            .code(400)
            .type("text/html; charset=utf-8")
            .send(statusView(app, request, reply, doctor, { values: body, errors: error.fields ?? {} }));
        }
        throw error;
      }
    },
  );

  app.get("/medicos/panel", { preHandler: requireApprovedDoctor }, async (_request, reply) => {
    return reply
      .type("text/html; charset=utf-8")
      .send(page({ title: "Mi panel", content: html`<h1>Mi panel</h1><p>Tu cuenta está aprobada.</p><ul><li><a href="/agenda">Mi agenda</a></li><li><a href="/medicos/micrositio">Mi micrositio</a></li><li><a href="/medicos/recepcion">Mi recepción</a></li></ul>` }));
  });
}
