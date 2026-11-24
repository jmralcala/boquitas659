import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Services } from "../../compose.js";
import { AppError, ConflictError, NotFoundError, ValidationError } from "../../http/errors.js";
import { wantsJson } from "../../http/negotiation.js";
import { parseInput } from "../../http/validate.js";
import { requireAuth, requireRole } from "../../http/session-plugin.js";
import type { Doctor } from "../doctors/doctor-repository.js";
import { actionBody, idParams, pageQuery, reasonSchema, stateActionBody } from "./state-rules.js";
import { doctorDetailView, doctorListView, historyView, mailView, metricsView, releaseView, sitesView, slugFormView, supportPage } from "./support-views.js";
import { html } from "../../lib/html.js";
import { PERIODS } from "./metrics-service.js";
import { appendSupportAction, historyFilters, listSupportActions } from "./action-log.js";

/** Límites de tasa del panel: lectura 120/min y cambios 30/hora, por IP (hay una o dos personas de soporte). */
const READ_LIMIT = { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } } as const;
const WRITE_LIMIT = { config: { rateLimit: { max: 30, timeWindow: "1 hour" } } } as const;

const DOCTOR_FILTERS = ["pending", "approved", "active", "read_only", "suspended", "rejected", "all"] as const;
// `status` se conserva como alias del filtro de la vista mínima de la feature 1.
const listQuery = z
  .object({
    estado: z.enum(DOCTOR_FILTERS, { error: "Estado inválido." }).optional(),
    status: z.enum(DOCTOR_FILTERS, { error: "Estado inválido." }).optional(),
    q: z.string().max(100, "La búsqueda es demasiado larga.").default(""),
  })
  .transform((value) => ({ estado: value.estado ?? value.status ?? "pending", q: value.q.trim() }));
const rejectBody = z.object({ reason: reasonSchema });
const metricsQuery = z.object({ periodo: z.enum(PERIODS, { error: "Periodo inválido." }).default("4semanas") });
const siteQuery = z.object({ estado: z.enum(["all", "published", "draft", "unpublished"], { error: "Estado inválido." }).default("all") });
const slugBody = actionBody.extend({ slug: z.string({ error: "Escribe el nombre nuevo." }).trim().max(100, "El nombre es demasiado largo.") });
const doctorIdParams = z.object({ doctorId: idParams.shape.id });

/** Ficha para clientes programáticos: sin el archivo de la cédula y sin datos de pacientes. */
function doctorJson(doctor: Doctor) {
  return {
    id: doctor.id,
    fullName: doctor.fullName,
    email: doctor.email,
    approvalStatus: doctor.approvalStatus,
    accountState: doctor.accountState,
    accountStateChangedAt: doctor.accountStateChangedAt,
    cedulaNumber: doctor.cedulaNumber,
    emergencyMobile: doctor.emergencyMobile,
    officePhone: doctor.officePhone,
    rejectionReason: doctor.rejectionReason,
    createdAt: doctor.createdAt,
  };
}

/**
 * Panel de soporte. El doble factor de soporte lo exige el filtro global de `src/http/support-mfa.ts`.
 * Soporte no es un tenant: ninguna ruta usa un contexto de médico ni consulta datos de pacientes.
 */
export function registerSupportRoutes(app: FastifyInstance, services: Services): void {
  const onlySupport = requireRole("support");
  const read = { preHandler: onlySupport, ...READ_LIMIT };
  const write = { preHandler: onlySupport, ...WRITE_LIMIT };

  app.get("/soporte/medicos", read, async (request, reply) => {
    const { estado, q } = parseInput(listQuery, request.query);
    const doctors = await services.support.search({ estado, q });
    if (wantsJson(request)) return reply.send({ doctors: doctors.map(doctorJson) });
    return reply.type("text/html; charset=utf-8").send(doctorListView({ doctors, estado, q }));
  });

  app.get("/soporte/medicos/:id", read, async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    const overview = await services.support.overview(id);
    if (!overview) throw new NotFoundError();
    if (wantsJson(request)) {
      return reply.send({ doctor: doctorJson(overview.doctor), site: overview.site, futureAppointments: overview.futureAppointments });
    }
    return reply.type("text/html; charset=utf-8").send(doctorDetailView({ overview, csrf: app.csrf.tokenFor(request, reply) }));
  });

  app.get("/soporte/medicos/:id/cedula", read, async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    const doctor = await services.support.get(id);
    if (!doctor?.cedulaFilePath) throw new NotFoundError();
    const file = await services.cedulaStorage.read(doctor.cedulaFilePath);
    if (!file) throw new NotFoundError();
    // Una lectura sensible se audita: si el registro falla, no se entrega el archivo.
    await appendSupportAction(services.db, { supportUserId: requireAuth(request).userId, action: "view_cedula", targetType: "doctor", targetId: doctor.id, reason: null, occurredAt: services.clock.now() });
    const extension = doctor.cedulaFilePath.slice(doctor.cedulaFilePath.lastIndexOf(".") + 1);
    return reply
      .header("content-type", file.mime)
      .header("content-disposition", `inline; filename="cedula.${extension}"`)
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "private, no-store")
      .send(file.buffer);
  });

  app.post("/soporte/medicos/:id/aprobar", write, async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    await services.support.approve(id, requireAuth(request).userId);
    return reply.redirect(`/soporte/medicos/${id}`, 303);
  });

  app.post("/soporte/medicos/:id/rechazar", write, async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    const { reason } = parseInput(rejectBody, request.body ?? {});
    await services.support.reject(id, requireAuth(request).userId, reason);
    return reply.redirect(`/soporte/medicos/${id}`, 303);
  });

  // La liberación deja a una cuenta aprobada sin acceso: antes de confirmar se muestra qué efecto tendrá (solo conteos).
  app.get("/soporte/medicos/:id/liberar-cedula", read, async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    const overview = await services.support.overview(id);
    if (!overview) throw new NotFoundError();
    if (wantsJson(request)) return reply.send({ futureAppointments: overview.futureAppointments, site: overview.site });
    return reply.type("text/html; charset=utf-8").send(releaseView({ overview, csrf: app.csrf.tokenFor(request, reply) }));
  });

  app.post("/soporte/medicos/:id/liberar-cedula", write, async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    const { reason } = parseInput(actionBody, request.body ?? {});
    await services.support.releaseCedula(id, requireAuth(request).userId, reason);
    return reply.redirect(`/soporte/medicos/${id}`, 303);
  });

  // Cambios del estado operativo: motivo, confirmación y el estado que la persona vio.
  const stateRoutes = [
    ["suspender", "suspend"],
    ["solo-lectura", "setReadOnly"],
    ["reactivar", "reactivate"],
  ] as const;
  for (const [path, method] of stateRoutes) {
    app.post(`/soporte/medicos/:id/${path}`, write, async (request, reply) => {
      const { id } = parseInput(idParams, request.params);
      const body = parseInput(stateActionBody, request.body ?? {});
      await services.accountState[method]({ doctorId: id, supportUserId: requireAuth(request).userId, reason: body.reason, from: body.from });
      return reply.redirect(`/soporte/medicos/${id}`, 303);
    });
  }

  // Inicio: lo que necesita atención, con accesos directos.
  app.get("/soporte", read, async (request, reply) => {
    const [pending, suspended, readOnly, mail] = await Promise.all([
      services.support.search({ estado: "pending" }),
      services.support.search({ estado: "suspended" }),
      services.support.search({ estado: "read_only" }),
      services.mailQueue.summary(1),
    ]);
    const data = { pending: pending.length, suspended: suspended.length, readOnly: readOnly.length, failedMail: mail.counts.failed };
    if (wantsJson(request)) return reply.send(data);
    return reply.type("text/html; charset=utf-8").send(
      supportPage(
        "Panel de soporte",
        html`<h1>Panel de soporte</h1>
<ul>
<li><a href="/soporte/medicos?estado=pending">Solicitudes pendientes de aprobar: ${data.pending}</a></li>
<li><a href="/soporte/medicos?estado=suspended">Cuentas suspendidas: ${data.suspended}</a></li>
<li><a href="/soporte/medicos?estado=read_only">Cuentas en solo lectura: ${data.readOnly}</a></li>
<li><a href="/soporte/correos">Correos fallidos: ${data.failedMail}</a></li>
</ul>`,
      ),
    );
  });

  // Micrositios: estado y cambio del nombre del enlace.
  app.get("/soporte/micrositios", read, async (request, reply) => {
    const { estado } = parseInput(siteQuery, request.query);
    const list = await services.siteAdmin.list(estado);
    if (wantsJson(request)) return reply.send(list);
    return reply.type("text/html; charset=utf-8").send(sitesView({ list, filter: estado }));
  });

  app.get("/soporte/micrositios/:doctorId/enlace", read, async (request, reply) => {
    const { doctorId } = parseInput(doctorIdParams, request.params);
    const current = await services.siteAdmin.currentSlug(doctorId);
    if (!current) throw new NotFoundError();
    return reply.type("text/html; charset=utf-8").send(slugFormView({ doctorId, doctorName: current.doctorName, slug: current.slug, csrf: app.csrf.tokenFor(request, reply) }));
  });

  app.post("/soporte/micrositios/:doctorId/enlace", write, async (request, reply) => {
    const { doctorId } = parseInput(doctorIdParams, request.params);
    const body = parseInput(slugBody, request.body ?? {});
    try {
      await services.siteAdmin.changeSlug({ doctorId, supportUserId: requireAuth(request).userId, newSlug: body.slug, reason: body.reason });
    } catch (error) {
      if (!wantsJson(request) && (error instanceof ValidationError || error instanceof ConflictError)) {
        const current = await services.siteAdmin.currentSlug(doctorId);
        if (!current) throw new NotFoundError();
        const messages = error instanceof ValidationError ? Object.values(error.fields ?? {}).flat() : [(error as AppError).publicMessage];
        return reply
          .code(error.status)
          .type("text/html; charset=utf-8")
          .send(slugFormView({ doctorId, doctorName: current.doctorName, slug: current.slug, csrf: app.csrf.tokenFor(request, reply), errors: messages, value: body.slug }));
      }
      throw error;
    }
    return reply.redirect("/soporte/micrositios", 303);
  });

  // Historial de acciones de soporte: solo lectura, filtrable y paginado.
  app.get("/soporte/historial", read, async (request, reply) => {
    const filters = parseInput(historyFilters, request.query);
    const history = await listSupportActions(services.db, filters);
    if (wantsJson(request)) return reply.send(history);
    return reply.type("text/html; charset=utf-8").send(historyView({ page: history, filters: { persona: filters.persona, accion: filters.accion, objetivo: filters.objetivo, desde: filters.desde, hasta: filters.hasta } }));
  });

  // Métricas del piloto: solo conteos y porcentajes.
  app.get("/soporte/metricas", read, async (request, reply) => {
    const { periodo } = parseInput(metricsQuery, request.query);
    const metrics = await services.metrics.compute(periodo);
    if (wantsJson(request)) return reply.send(metrics);
    return reply.type("text/html; charset=utf-8").send(metricsView(metrics));
  });

  // Cola de correos: conteos y fallidos, sin contenido.
  app.get("/soporte/correos", read, async (request, reply) => {
    const { pagina } = parseInput(pageQuery, request.query);
    const summary = await services.mailQueue.summary(pagina);
    if (wantsJson(request)) return reply.send(summary);
    return reply.type("text/html; charset=utf-8").send(mailView({ summary, csrf: app.csrf.tokenFor(request, reply), now: services.clock.now() }));
  });

  for (const [path, method] of [["reintentar", "retry"], ["cancelar", "cancel"]] as const) {
    app.post(`/soporte/correos/:id/${path}`, write, async (request, reply) => {
      const { id } = parseInput(idParams, request.params);
      const body = parseInput(actionBody, request.body ?? {});
      await services.mailQueue[method]({ emailId: id, supportUserId: requireAuth(request).userId, reason: body.reason });
      return reply.redirect("/soporte/correos", 303);
    });
  }
}
