import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Services } from "../../compose.js";
import { NotFoundError } from "../../http/errors.js";
import { parseInput } from "../../http/validate.js";
import { requireAuth, requireRole } from "../../http/session-plugin.js";
import { csrfInput } from "../../http/views/forms.js";
import { page } from "../../http/views/layout.js";
import { html } from "../../lib/html.js";
import type { Doctor } from "../doctors/doctor-repository.js";

const idParams = z.object({ id: z.coerce.number({ error: "Id inválido." }).int("Id inválido.").positive("Id inválido.") });
const listQuery = z.object({ status: z.enum(["pending", "approved", "rejected", "all"]).default("pending") });
const reasonBody = z.object({ reason: z.string().max(2000).default("") });

const STATUS_LABEL = { pending: "Pendiente", approved: "Aprobada", rejected: "Rechazada" } as const;

function detailView(doctor: Doctor, csrf: string): string {
  const action = (name: string) => `/soporte/medicos/${doctor.id}/${name}`;
  return page({
    title: `Solicitud de ${doctor.fullName}`,
    content: html`<h1>${doctor.fullName}</h1>
<p><a href="/soporte/medicos">← Volver a la lista</a></p>
<dl>
  <dt>Estado</dt><dd>${STATUS_LABEL[doctor.approvalStatus]}</dd>
  <dt>Correo</dt><dd>${doctor.email}</dd>
  <dt>Cédula</dt><dd>${doctor.cedulaNumber ?? "(liberada)"}</dd>
  <dt>Móvil de emergencias</dt><dd>${doctor.emergencyMobile ?? "(liberado)"}</dd>
  <dt>Teléfono del consultorio</dt><dd>${doctor.officePhone ?? "—"}</dd>
  <dt>Motivo de rechazo</dt><dd>${doctor.rejectionReason ?? "—"}</dd>
</dl>
${doctor.cedulaFilePath ? html`<p><a href="${action("cedula")}" target="_blank" rel="noopener">Ver archivo de la cédula</a></p>` : html`<p>Sin archivo de cédula.</p>`}
${
  doctor.approvalStatus === "pending"
    ? html`<form method="post" action="${action("aprobar")}">${csrfInput(csrf)}<button type="submit">Aprobar</button></form>
<form method="post" action="${action("rechazar")}">${csrfInput(csrf)}
  <label>Motivo del rechazo <input type="text" name="reason" required maxlength="500"></label>
  <button type="submit">Rechazar</button>
</form>`
    : null
}
<form method="post" action="${action("liberar-cedula")}">${csrfInput(csrf)}
  <label>Motivo para liberar cédula y móvil <input type="text" name="reason" required maxlength="500"></label>
  <button type="submit">Liberar cédula y móvil</button>
</form>`,
  });
}

/**
 * Vista mínima de soporte: revisar, aprobar, rechazar y liberar cédulas.
 * IMPORTANTE: antes de exponer estas rutas en producción debe exigirse el segundo factor (US6).
 */
export function registerSupportRoutes(app: FastifyInstance, services: Services): void {
  const onlySupport = requireRole("support");

  app.get("/soporte/medicos", { preHandler: onlySupport }, async (request, reply) => {
    const { status } = parseInput(listQuery, request.query);
    const doctors = await services.support.list(status);
    const rows = doctors.map(
      (d) => html`<tr><td><a href="/soporte/medicos/${d.id}">${d.fullName}</a></td><td>${STATUS_LABEL[d.approvalStatus]}</td><td>${d.createdAt.toISOString().slice(0, 10)}</td></tr>`,
    );
    return reply.type("text/html; charset=utf-8").send(
      page({
        title: "Solicitudes de médicos",
        content: html`<h1>Solicitudes de médicos</h1>
<p><a href="/soporte/medicos?status=pending">Pendientes</a> · <a href="/soporte/medicos?status=approved">Aprobadas</a> · <a href="/soporte/medicos?status=rejected">Rechazadas</a> · <a href="/soporte/medicos?status=all">Todas</a></p>
<table><thead><tr><th>Médico</th><th>Estado</th><th>Fecha</th></tr></thead><tbody>${rows}</tbody></table>
${doctors.length === 0 ? html`<p>No hay solicitudes en este estado.</p>` : null}`,
      }),
    );
  });

  app.get("/soporte/medicos/:id", { preHandler: onlySupport }, async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    const doctor = await services.support.get(id);
    if (!doctor) throw new NotFoundError();
    return reply
      .type("text/html; charset=utf-8")
      .send(detailView(doctor, app.csrf.tokenFor(request, reply)));
  });

  app.get("/soporte/medicos/:id/cedula", { preHandler: onlySupport }, async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    const doctor = await services.support.get(id);
    if (!doctor?.cedulaFilePath) throw new NotFoundError();
    const file = await services.cedulaStorage.read(doctor.cedulaFilePath);
    if (!file) throw new NotFoundError();
    const extension = doctor.cedulaFilePath.slice(doctor.cedulaFilePath.lastIndexOf(".") + 1);
    return reply
      .header("content-type", file.mime)
      .header("content-disposition", `inline; filename="cedula.${extension}"`)
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "private, no-store")
      .send(file.buffer);
  });

  app.post("/soporte/medicos/:id/aprobar", { preHandler: onlySupport }, async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    await services.support.approve(id, requireAuth(request).userId);
    return reply.redirect(`/soporte/medicos/${id}`, 303);
  });

  app.post("/soporte/medicos/:id/rechazar", { preHandler: onlySupport }, async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    const { reason } = parseInput(reasonBody, request.body ?? {});
    await services.support.reject(id, requireAuth(request).userId, reason);
    return reply.redirect(`/soporte/medicos/${id}`, 303);
  });

  app.post("/soporte/medicos/:id/liberar-cedula", { preHandler: onlySupport }, async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    const { reason } = parseInput(reasonBody, request.body ?? {});
    await services.support.releaseCedula(id, requireAuth(request).userId, reason);
    return reply.redirect(`/soporte/medicos/${id}`, 303);
  });
}

