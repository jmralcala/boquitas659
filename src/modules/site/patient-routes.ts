import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Services } from "../../compose.js";
import { ConflictError, ValidationError } from "../../http/errors.js";
import { wantsJson } from "../../http/negotiation.js";
import { isFullyAuthenticated, requireAuth, requireRole, setSessionCookie } from "../../http/session-plugin.js";
import {
  additionalPatientPage,
  appointmentLinkGonePage,
  appointmentLinkLoginPage,
  appointmentLinkSummaryPage,
  bookingPage,
  myAppointmentsPage,
  myOfficesPage,
  patientAppointmentPage,
  revokeOfficePage,
} from "../../http/views/site.js";
import type { TenantContext } from "../../lib/tenant.js";
import { utcToLocal } from "../../lib/zoned-time.js";
import { DEVICE_COOKIE, setDeviceCookie } from "../auth/devices.js";
import { loadSettings } from "../calendar/settings-repository.js";
import { findAccountByUserId, listPatientsByAccount } from "../patients/patient-repository.js";
import { getDayView, getMonthView, type DayView } from "./availability-view.js";
import { hasActiveAuthorization } from "./authorization.js";
import { reserveAsPatient } from "./booking-service.js";
import { listOffices, previewRevocation, revoke } from "./offices-service.js";
import { cancelAsPatient, getForAccount, listForAccount } from "./patient-appointments.js";
import type { PublishedSite } from "./site-resolver.js";

/** Reservas por IP: 20 por hora (además de los límites por cuenta del servicio). */
const BOOKING_RATE_LIMIT = { config: { rateLimit: { max: 20, timeWindow: "1 hour" } } } as const;
/** Lectura de las pantallas de reserva: 120 por minuto por IP (igual que el micrositio público). */
const BOOKING_RATE_LIMIT_READ = { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } } as const;
const DEPENDENT_RATE_LIMIT = { config: { rateLimit: { max: 30, timeWindow: "1 hour" } } } as const;

const querySchema = z.object({
  mes: z.string().max(10).optional(),
  fecha: z.string().max(10).optional(),
});

const bookingBodySchema = z.object({
  inicio: z.string({ error: "Elige un horario." }).trim().min(1, "Elige un horario.").max(16, "Elige un horario válido."),
  patientId: z.coerce.number({ error: "Elige al paciente." }).int("Elige al paciente.").positive("Elige al paciente."),
  autorizo: z.string().optional(),
});

function stringFields(body: Record<string, unknown>, keys: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const key of keys) {
    const value = body[key];
    values[key] = typeof value === "string" ? value.slice(0, 300) : "";
  }
  return values;
}

/** Rutas del paciente: reserva, pacientes adicionales y, en las siguientes historias, citas y consultorios. */
export function registerSitePatientRoutes(app: FastifyInstance, services: Services): void {
  /** Contexto de paciente frente al consultorio del enlace (el médico sale del `slug`, nunca de un dato del cliente). */
  async function patientSite(request: FastifyRequest, slug: string): Promise<{ ctx: TenantContext; site: PublishedSite; userId: number }> {
    const resolved = await services.site.resolvePatientSite(request.auth, slug);
    return { ctx: resolved.ctx, site: resolved.site, userId: resolved.auth.userId };
  }

  async function renderBooking(
    request: FastifyRequest,
    reply: FastifyReply,
    resolved: { ctx: TenantContext; site: PublishedSite; userId: number },
    options: { fecha: string | null; mes: string | null; selectedPatientId?: number | null; selectedStart?: string | null; errors?: Readonly<Record<string, readonly string[]>>; notice?: string },
  ): Promise<{ html: string; json: unknown }> {
    const now = services.clock.now();
    const { ctx, site, userId } = resolved;
    const account = await findAccountByUserId(services.db, userId);
    const patients = account ? await listPatientsByAccount(services.db, account.id) : [];
    const needsAuthorization = account ? !(await hasActiveAuthorization(ctx, services.db, account.id)) : true;

    let day: DayView | null = null;
    if (options.fecha !== null) {
      try {
        day = await getDayView(ctx, services.db, options.fecha, now);
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        if (options.notice === undefined) throw error;
        day = null; // al volver a mostrar tras un rechazo, una fecha ya no reservable no debe impedir ver el calendario
      }
    }
    const { settings } = await loadSettings(ctx, services.db);
    const month = await getMonthView(ctx, services.db, options.fecha !== null ? options.fecha.slice(0, 7) : (options.mes ?? utcToLocal(settings.timezone, now).date.slice(0, 7)), now);

    const patientOptions = patients.map((patient) => ({ id: patient.id, name: patient.fullName }));
    return {
      html: bookingPage({
        slug: site.slug,
        doctorName: site.doctorName,
        csrf: app.csrf.tokenFor(request, reply),
        month,
        day,
        patients: patientOptions,
        selectedPatientId: options.selectedPatientId ?? null,
        selectedStart: options.selectedStart ?? null,
        needsAuthorization,
        errors: options.errors ?? {},
        ...(options.notice !== undefined ? { notice: options.notice } : {}),
      }),
      json: {
        timezone: month.timezone,
        month,
        day: day && { date: day.date, slots: day.slots.map((slot) => ({ start: slot.startLocal })) },
        patients: patientOptions,
        needsAuthorization,
      },
    };
  }

  app.get("/c/:slug/reservar", BOOKING_RATE_LIMIT_READ, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    // Sin sesión de paciente se vuelve al micrositio, que ofrece «Primera cita» y «Ya soy paciente».
    if (!isFullyAuthenticated(request.auth)) return reply.redirect(`/c/${slug}`, 303);
    const resolved = await patientSite(request, slug);
    const parsed = querySchema.safeParse(request.query ?? {});
    if (!parsed.success) throw new ValidationError({ fecha: ["Elige una fecha válida."] });
    const rendered = await renderBooking(request, reply, resolved, { fecha: parsed.data.fecha ?? null, mes: parsed.data.mes ?? null });
    if (wantsJson(request)) return reply.send(rendered.json);
    return reply.type("text/html; charset=utf-8").send(rendered.html);
  });

  app.post("/c/:slug/reservar", BOOKING_RATE_LIMIT, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const resolved = await patientSite(request, slug);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const startLocal = typeof body.inicio === "string" ? body.inicio.trim().slice(0, 16) : "";
    const fecha = /^\d{4}-\d{2}-\d{2}/.test(startLocal) ? startLocal.slice(0, 10) : null;
    const rerender = async (status: number, extra: { errors?: Readonly<Record<string, readonly string[]>>; notice?: string }) => {
      const rendered = await renderBooking(request, reply, resolved, {
        fecha,
        mes: null,
        selectedPatientId: Number(body.patientId) || null,
        selectedStart: startLocal || null,
        ...extra,
      });
      if (wantsJson(request)) return reply.code(status).send(rendered.json);
      return reply.code(status).type("text/html; charset=utf-8").send(rendered.html);
    };

    const parsed = bookingBodySchema.safeParse(body);
    if (!parsed.success) {
      const errors: Record<string, string[]> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] === "patientId" ? "patientId" : "inicio";
        (errors[key] ??= []).push(issue.message);
      }
      return rerender(400, { errors });
    }

    try {
      const result = await reserveAsPatient(resolved.ctx, { db: services.db, clock: services.clock }, {
        startLocal: parsed.data.inicio,
        patientId: parsed.data.patientId,
        authorize: parsed.data.autorizo === "yes",
      });
      return reply.redirect(`/pacientes/citas/${result.id}`, 303);
    } catch (error) {
      if (error instanceof ValidationError) return rerender(400, { errors: error.fields ?? {} });
      if (error instanceof ConflictError) {
        return rerender(409, error.code === "slot_unavailable" ? { notice: "Ese horario ya no está disponible. Elige otro de los que se muestran." } : { errors: { _: [error.publicMessage] } });
      }
      throw error;
    }
  });

  registerLinkRoutes(app, services);
  registerMyAppointmentRoutes(app, services);
  registerOfficeRoutes(app, services);

  app.get("/c/:slug/paciente-adicional", BOOKING_RATE_LIMIT_READ, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    if (!isFullyAuthenticated(request.auth)) return reply.redirect(`/c/${slug}`, 303);
    const { site } = await patientSite(request, slug);
    return reply
      .type("text/html; charset=utf-8")
      .send(additionalPatientPage({ slug: site.slug, doctorName: site.doctorName, csrf: app.csrf.tokenFor(request, reply), values: {}, errors: {} }));
  });

  app.post("/c/:slug/paciente-adicional", DEPENDENT_RATE_LIMIT, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const { site, userId } = await patientSite(request, slug);
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      await services.dependents.addDependent(userId, body);
      return reply.redirect(`/c/${site.slug}/reservar`, 303);
    } catch (error) {
      if (error instanceof ValidationError) {
        return reply
          .code(400)
          .type("text/html; charset=utf-8")
          .send(
            additionalPatientPage({
              slug: site.slug,
              doctorName: site.doctorName,
              csrf: app.csrf.tokenFor(request, reply),
              values: stringFields(body, ["fullName", "birthDate", "phone"]),
              errors: error.fields ?? {},
            }),
          );
      }
      throw error;
    }
  });
}

// --- Enlaces de correo de una cita -----------------------------------------------------------------------------------------

/** Los dos enlaces del correo comparten el límite: 60 peticiones por minuto por IP. */
const LINK_RATE_LIMIT = { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } } as const;

const linkLoginSchema = z.object({ email: z.string().min(1).max(254), password: z.string().min(1).max(1000) });

/**
 * `GET /citas/enlace/:token` valida SIN consumir ni cambiar nada (también lo abren los clientes de correo y los
 * antivirus); `POST …/entrar` inicia la sesión del paciente y regresa al mismo enlace. Cualquier enlace que no sirva
 * recibe la misma respuesta 410, sin datos.
 */
function registerLinkRoutes(app: FastifyInstance, services: Services): void {
  const gone = (reply: FastifyReply) => reply.code(410).type("text/html; charset=utf-8").send(appointmentLinkGonePage());

  app.get("/citas/enlace/:token", LINK_RATE_LIMIT, async (request, reply) => {
    const { token } = request.params as { token: string };
    const resolution = await services.links.resolve(token, isFullyAuthenticated(request.auth) ? request.auth : null);
    if (resolution.kind === "gone") return gone(reply);
    if (resolution.kind === "login_required") {
      return reply.type("text/html; charset=utf-8").send(appointmentLinkLoginPage({ token, csrf: app.csrf.tokenFor(request, reply), email: "" }));
    }
    return reply
      .type("text/html; charset=utf-8")
      .send(appointmentLinkSummaryPage({ token, csrf: app.csrf.tokenFor(request, reply), summary: resolution.summary }));
  });

  app.post("/citas/enlace/:token/entrar", LINK_RATE_LIMIT, async (request, reply) => {
    const { token } = request.params as { token: string };
    if (!(await services.links.isLive(token))) return gone(reply);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const email = typeof body.email === "string" ? body.email.slice(0, 254) : "";
    const view = (error: string) => appointmentLinkLoginPage({ token, csrf: app.csrf.tokenFor(request, reply), email, error });
    const parsed = linkLoginSchema.safeParse(body);
    if (!parsed.success) return reply.code(400).type("text/html; charset=utf-8").send(view("Escribe tu correo y tu contraseña."));

    const outcome = await services.login.authenticate({
      email: parsed.data.email,
      password: parsed.data.password,
      ip: request.ip,
      deviceCookie: request.cookies[DEVICE_COOKIE],
      currentSessionToken: request.sessionToken,
      audience: "patient",
    });
    if (outcome.kind === "throttled") {
      const seconds = Math.max(1, Math.ceil(outcome.retryAfterMs / 1000));
      return reply
        .code(429)
        .header("retry-after", String(seconds))
        .type("text/html; charset=utf-8")
        .send(view(`Demasiados intentos. Espera ${seconds} segundos e inténtalo de nuevo.`));
    }
    // Aquí no se ofrece crear cuenta: el enlace es de una cita ya agendada.
    if (outcome.kind !== "success") return reply.code(401).type("text/html; charset=utf-8").send(view("Correo o contraseña incorrectos."));
    setDeviceCookie(reply, outcome.deviceId);
    setSessionCookie(reply, outcome.sessionToken);
    return reply.redirect(outcome.mfaEnabled ? "/login/mfa" : `/citas/enlace/${encodeURIComponent(token)}`, 303);
  });

  /** Cancela desde el enlace del correo: exige la sesión de la cuenta dueña, respeta el límite y CONSUME el token. */
  app.post("/citas/enlace/:token/cancelar", CANCEL_RATE_LIMIT, async (request, reply) => {
    const { token } = request.params as { token: string };
    const auth = isFullyAuthenticated(request.auth) ? request.auth : null;
    const resolution = await services.links.resolve(token, auth);
    if (resolution.kind === "gone") return gone(reply);
    if (resolution.kind === "login_required" || auth === null) return reply.redirect(`/citas/enlace/${encodeURIComponent(token)}`, 303);
    try {
      await cancelAsPatient({ db: services.db, clock: services.clock }, auth.userId, resolution.summary.appointmentId);
    } catch (error) {
      if (error instanceof ConflictError) {
        return reply
          .code(409)
          .type("text/html; charset=utf-8")
          .send(appointmentLinkSummaryPage({ token, csrf: app.csrf.tokenFor(request, reply), summary: resolution.summary, notice: error.publicMessage }));
      }
      throw error;
    }
    await services.links.consume(token);
    return reply.redirect("/pacientes/citas", 303);
  });
}

/** Cancelaciones: 30 por hora por IP (además de las 10 por hora por cuenta del servicio). */
const CANCEL_RATE_LIMIT = { config: { rateLimit: { max: 30, timeWindow: "1 hour" } } } as const;

const idParamsSchema = z.object({ id: z.coerce.number().int().positive() });

/** «Mis citas» del paciente: lista, detalle y cancelación. Solo cuentas de paciente (los demás roles reciben 403). */
function registerMyAppointmentRoutes(app: FastifyInstance, services: Services): void {
  app.get("/pacientes/citas", { preHandler: requireRole("patient"), ...BOOKING_RATE_LIMIT_READ }, async (request, reply) => {
    const list = await listForAccount(services.db, requireAuth(request).userId, services.clock.now());
    return reply.type("text/html; charset=utf-8").send(myAppointmentsPage(list));
  });

  app.get("/pacientes/citas/:id", { preHandler: requireRole("patient"), ...BOOKING_RATE_LIMIT_READ }, async (request, reply) => {
    const parsed = idParamsSchema.safeParse(request.params);
    if (!parsed.success) throw new ValidationError({ id: ["La cita no es válida."] });
    const item = await getForAccount(services.db, requireAuth(request).userId, parsed.data.id, services.clock.now());
    return reply.type("text/html; charset=utf-8").send(patientAppointmentPage({ item, csrf: app.csrf.tokenFor(request, reply) }));
  });

  app.post("/pacientes/citas/:id/cancelar", { preHandler: requireRole("patient"), ...CANCEL_RATE_LIMIT }, async (request, reply) => {
    const parsed = idParamsSchema.safeParse(request.params);
    if (!parsed.success) throw new ValidationError({ id: ["La cita no es válida."] });
    const userId = requireAuth(request).userId;
    try {
      await cancelAsPatient({ db: services.db, clock: services.clock }, userId, parsed.data.id);
    } catch (error) {
      if (error instanceof ConflictError) {
        const item = await getForAccount(services.db, userId, parsed.data.id, services.clock.now());
        return reply
          .code(409)
          .type("text/html; charset=utf-8")
          .send(patientAppointmentPage({ item, csrf: app.csrf.tokenFor(request, reply), notice: error.publicMessage }));
      }
      throw error;
    }
    return reply.redirect("/pacientes/citas", 303);
  });
}

const doctorParamsSchema = z.object({ doctorId: z.coerce.number().int().positive() });

/** «Mis consultorios»: ver quién tiene acceso al contacto y revocar el vínculo (cancela las citas futuras con ese consultorio). */
function registerOfficeRoutes(app: FastifyInstance, services: Services): void {
  app.get("/pacientes/consultorios", { preHandler: requireRole("patient"), ...BOOKING_RATE_LIMIT_READ }, async (request, reply) => {
    const offices = await listOffices(services.db, requireAuth(request).userId);
    return reply.type("text/html; charset=utf-8").send(myOfficesPage(offices));
  });

  app.get("/pacientes/consultorios/:doctorId/revocar", { preHandler: requireRole("patient"), ...BOOKING_RATE_LIMIT_READ }, async (request, reply) => {
    const parsed = doctorParamsSchema.safeParse(request.params);
    if (!parsed.success) throw new ValidationError({ doctorId: ["El consultorio no es válido."] });
    const preview = await previewRevocation(services.db, requireAuth(request).userId, parsed.data.doctorId, services.clock.now());
    return reply.type("text/html; charset=utf-8").send(revokeOfficePage({ ...preview, csrf: app.csrf.tokenFor(request, reply) }));
  });

  app.post("/pacientes/consultorios/:doctorId/revocar", { preHandler: requireRole("patient"), ...CANCEL_RATE_LIMIT }, async (request, reply) => {
    const parsed = doctorParamsSchema.safeParse(request.params);
    if (!parsed.success) throw new ValidationError({ doctorId: ["El consultorio no es válido."] });
    await revoke({ db: services.db, clock: services.clock }, requireAuth(request).userId, parsed.data.doctorId);
    return reply.redirect("/pacientes/consultorios", 303);
  });
}
