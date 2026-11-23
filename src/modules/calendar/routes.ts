import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Services } from "../../compose.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../../http/errors.js";
import { wantsJson } from "../../http/negotiation.js";
import {
  appointmentDetailPage,
  blockConflictPage,
  blocksPage,
  configFormValues,
  configurationPage,
  dayPage,
  formatDateTime,
  newAppointmentPage,
  weekPage,
} from "../../http/views/calendar.js";
import { z } from "zod";
import { parseInput } from "../../http/validate.js";
import { ALLOWED_TIMEZONES, formatLocalInstant, isValidLocalDate, utcToLocal } from "../../lib/zoned-time.js";
import type { TenantContext } from "../../lib/tenant.js";
import { getDay, getWeek, type AgendaDay } from "./agenda-service.js";
import { cancelAppointment, createAppointment, describeFreeSlot, parseLocalStart } from "./appointment-service.js";
import { findAppointment } from "./appointment-repository.js";
import { listUpcomingBlocks } from "./block-repository.js";
import { BlockConflictError, blockSlot, createBlock, removeBlock } from "./block-service.js";
import { listLinkedPatients, lookupPatientsByEmail } from "./patient-picker.js";
import { parseCalendarForm } from "./settings.js";
import { loadSettings, saveSettings } from "./settings-repository.js";

function minutesText(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

const dateParams = z.object({
  fecha: z.string().refine(isValidLocalDate, "La fecha no es válida (usa AAAA-MM-DD)."),
});


const inicioSchema = z.string().refine((value) => parseLocalStart(value) !== null, "Elige una fecha y hora válidas.");
const newQuery = z.object({ inicio: inicioSchema });
const lookupBody = z.object({ inicio: inicioSchema, email: z.string().trim().min(3, "Escribe el correo.").max(254, "El correo es demasiado largo.") });
const createBody = z.object({
  inicio: inicioSchema,
  patientId: z.coerce.number({ error: "Elige un paciente." }).int("Elige un paciente.").positive("Elige un paciente."),
  ticket: z.string().max(200).optional(),
});
const blockBody = z.object({
  desdeFecha: z.string().max(10, "La fecha es demasiado larga.").default(""),
  desdeHora: z.string().max(10, "La hora es demasiado larga.").default(""),
  hastaFecha: z.string().max(10, "La fecha es demasiado larga.").default(""),
  hastaHora: z.string().max(10, "La hora es demasiado larga.").default(""),
  motivo: z.string().max(200, "El motivo admite hasta 200 caracteres.").default(""),
});
const slotBody = z.object({ inicio: inicioSchema });
const idParams = z.object({ id: z.coerce.number({ error: "Id inválido." }).int("Id inválido.").positive("Id inválido.") });

/** Vista de un día para clientes JSON: instantes en hora local del consultorio (`AAAA-MM-DDTHH:MM`). */
function dayJson(day: AgendaDay): Record<string, unknown> {
  const local = (instant: Date): string => formatLocalInstant(day.timezone, instant);
  return {
    date: day.date,
    timezone: day.timezone,
    weekday: day.weekday,
    previousDate: day.previousDate,
    nextDate: day.nextDate,
    slots: day.slots.map((slot) => ({
      start: local(slot.startUtc),
      end: local(slot.endUtc),
      state: slot.state,
      ...(slot.appointmentId === undefined ? {} : { appointmentId: slot.appointmentId }),
    })),
    appointments: day.appointments.map((appointment) => ({
      id: appointment.id,
      patientName: appointment.patientName,
      start: local(appointment.startUtc),
      end: local(appointment.endUtc),
      outOfSchedule: appointment.outOfSchedule,
    })),
    blocks: day.blocks.map((block) => ({ id: block.id, start: local(block.startUtc), end: local(block.endUtc), reason: block.reason })),
  };
}

/**
 * Rutas de la agenda del médico (contracts/http-routes.md). El médico SIEMPRE sale del contexto de médico
 * (`services.tenants.resolve`: el propio médico aprobado o recepción con vínculo vigente EN ESTE MOMENTO), nunca de un
 * parámetro de la petición.
 */
export function registerCalendarRoutes(app: FastifyInstance, services: Services): void {
  /** Solo el médico configura: recepción recibe 403 también en la lectura. */
  async function resolveDoctorOnly(request: FastifyRequest): Promise<TenantContext> {
    const tenant = await services.tenants.resolve(request);
    if (tenant.actor.kind !== "doctor") throw new ForbiddenError();
    return tenant;
  }

  app.get("/agenda", async (request, reply) => {
    const tenant = await services.tenants.resolve(request);
    const { settings } = await loadSettings(tenant, services.db);
    const today = utcToLocal(settings.timezone, services.clock.now()).date;
    return reply.redirect(`/agenda/dia/${today}`, 303);
  });

  // --- Agenda por día y por semana ----------------------------------------------------------------------------

  app.get("/agenda/dia/:fecha", async (request, reply) => {
    const tenant = await services.tenants.resolve(request);
    const { fecha } = parseInput(dateParams, request.params);
    const day = await getDay(tenant, services.db, fecha, services.clock.now());
    if (wantsJson(request)) return reply.send(dayJson(day));
    return reply.type("text/html; charset=utf-8").send(dayPage({ day, csrf: app.csrf.tokenFor(request, reply), canConfigure: tenant.actor.kind === "doctor" }));
  });

  app.get("/agenda/semana/:fecha", async (request, reply) => {
    const tenant = await services.tenants.resolve(request);
    const { fecha } = parseInput(dateParams, request.params);
    const week = await getWeek(tenant, services.db, fecha, services.clock.now());
    if (wantsJson(request)) {
      return reply.send({
        timezone: week.timezone,
        startDate: week.startDate,
        previousDate: week.previousDate,
        nextDate: week.nextDate,
        days: week.days.map(dayJson),
      });
    }
    return reply.type("text/html; charset=utf-8").send(weekPage({ week, csrf: app.csrf.tokenFor(request, reply), canConfigure: tenant.actor.kind === "doctor" }));
  });

  // --- Citas ---------------------------------------------------------------------------------------------------

  const deps = (): { db: Services["db"]; clock: Services["clock"]; ticketSecret: string } => ({
    db: services.db,
    clock: services.clock,
    ticketSecret: services.env.SESSION_SECRET,
  });

  /** Pantalla de nueva cita; 404 si el espacio ya no está libre y futuro. */
  async function renderNewAppointment(
    request: FastifyRequest,
    reply: FastifyReply,
    tenant: TenantContext,
    inicio: string,
    lookup: { email: string; patients: { patientId: number; fullName: string; ticket: string }[] } | null,
  ): Promise<FastifyReply> {
    const free = await describeFreeSlot(tenant, services.db, inicio, services.clock.now());
    if (!free) throw new NotFoundError();
    const patients = await listLinkedPatients(tenant, services.db);
    if (wantsJson(request)) {
      return reply.send({ inicio, timezone: free.timezone, patients, ...(lookup ? { lookup: lookup.patients } : {}) });
    }
    return reply.type("text/html; charset=utf-8").send(
      newAppointmentPage({
        csrf: app.csrf.tokenFor(request, reply),
        startLocal: inicio,
        whenLabel: formatDateTime(free.timezone, free.slot.startUtc),
        linkedPatients: patients,
        lookup,
        canConfigure: tenant.actor.kind === "doctor",
      }),
    );
  }

  app.get("/agenda/citas/nueva", async (request, reply) => {
    const tenant = await services.tenants.resolve(request);
    const { inicio } = parseInput(newQuery, request.query ?? {});
    return renderNewAppointment(request, reply, tenant, inicio, null);
  });

  app.post("/agenda/citas/buscar", async (request, reply) => {
    const tenant = await services.tenants.resolve(request);
    const { inicio, email } = parseInput(lookupBody, request.body ?? {});
    const result = await lookupPatientsByEmail(tenant, deps(), email);
    if (wantsJson(request)) return reply.send(result);
    return renderNewAppointment(request, reply, tenant, inicio, { email, patients: result.patients });
  });

  app.post("/agenda/citas", async (request, reply) => {
    const tenant = await services.tenants.resolve(request);
    const input = parseInput(createBody, request.body ?? {});
    await createAppointment(tenant, deps(), { startLocal: input.inicio, patientId: input.patientId, ticket: input.ticket });
    return reply.redirect(`/agenda/dia/${input.inicio.slice(0, 10)}`, 303);
  });

  app.get("/agenda/citas/:id", async (request, reply) => {
    const tenant = await services.tenants.resolve(request);
    const { id } = parseInput(idParams, request.params);
    const appointment = await findAppointment(tenant, services.db, id);
    if (!appointment) throw new NotFoundError();
    const { settings } = await loadSettings(tenant, services.db);
    const cancelable = appointment.status === "booked" && appointment.endUtc.getTime() > services.clock.now().getTime();
    if (wantsJson(request)) {
      return reply.send({
        id: appointment.id,
        patientName: appointment.patientName,
        start: formatLocalInstant(settings.timezone, appointment.startUtc),
        end: formatLocalInstant(settings.timezone, appointment.endUtc),
        status: appointment.status,
        createdByRole: appointment.createdByRole,
        cancelable,
        patientDetailPath: `/agenda/pacientes/${appointment.patientId}`,
      });
    }
    return reply.type("text/html; charset=utf-8").send(
      appointmentDetailPage({
        csrf: app.csrf.tokenFor(request, reply),
        id: appointment.id,
        patientId: appointment.patientId,
        patientName: appointment.patientName,
        timezone: settings.timezone,
        startUtc: appointment.startUtc,
        endUtc: appointment.endUtc,
        status: appointment.status,
        createdByRole: appointment.createdByRole,
        cancelledByRole: appointment.cancelledByRole,
        cancelledAt: appointment.cancelledAt,
        cancelable,
        canConfigure: tenant.actor.kind === "doctor",
      }),
    );
  });

  app.post("/agenda/citas/:id/cancelar", async (request, reply) => {
    const tenant = await services.tenants.resolve(request);
    const { id } = parseInput(idParams, request.params);
    // La fecha de la cita se lee antes de cancelar (404 si es de otro médico) para volver a la agenda de ese día.
    const appointment = await findAppointment(tenant, services.db, id);
    if (!appointment) throw new NotFoundError();
    const { settings } = await loadSettings(tenant, services.db);
    await cancelAppointment(tenant, deps(), id);
    return reply.redirect(`/agenda/dia/${utcToLocal(settings.timezone, appointment.startUtc).date}`, 303);
  });

  // --- Bloqueos ------------------------------------------------------------------------------------------------

  const blockDeps = (): { db: Services["db"]; clock: Services["clock"] } => ({ db: services.db, clock: services.clock });

  /** El 409 de «hay citas en ese horario»: en JSON la lista de citas; en HTML una pantalla que las enumera. */
  async function replyBlockConflict(
    request: FastifyRequest,
    reply: FastifyReply,
    tenant: TenantContext,
    error: BlockConflictError,
  ): Promise<FastifyReply> {
    const { settings } = await loadSettings(tenant, services.db);
    reply.code(409);
    if (wantsJson(request)) {
      return reply.send({
        error: error.code,
        message: error.publicMessage,
        appointments: error.appointments.map((appointment) => ({
          id: appointment.id,
          startLocal: formatLocalInstant(settings.timezone, appointment.startUtc),
          patientName: appointment.patientName,
        })),
        total: error.total,
      });
    }
    return reply.type("text/html; charset=utf-8").send(
      blockConflictPage({ timezone: settings.timezone, appointments: error.appointments, total: error.total, canConfigure: tenant.actor.kind === "doctor" }),
    );
  }

  async function renderBlocks(
    request: FastifyRequest,
    reply: FastifyReply,
    tenant: TenantContext,
    page: { status?: number; values?: Record<string, string>; errors?: Readonly<Record<string, readonly string[]>> } = {},
  ): Promise<FastifyReply> {
    const { settings } = await loadSettings(tenant, services.db);
    const blocks = await listUpcomingBlocks(tenant, services.db, services.clock.now());
    if (wantsJson(request)) {
      return reply.send({
        blocks: blocks.map((block) => ({
          id: block.id,
          start: formatLocalInstant(settings.timezone, block.startUtc),
          end: formatLocalInstant(settings.timezone, block.endUtc),
          reason: block.reason,
          createdByRole: block.createdByRole,
        })),
      });
    }
    return reply
      .code(page.status ?? 200)
      .type("text/html; charset=utf-8")
      .send(
        blocksPage({
          csrf: app.csrf.tokenFor(request, reply),
          timezone: settings.timezone,
          blocks,
          ...(page.values ? { values: page.values } : {}),
          ...(page.errors ? { errors: page.errors } : {}),
          canConfigure: tenant.actor.kind === "doctor",
        }),
      );
  }

  app.get("/agenda/bloqueos", async (request, reply) => {
    const tenant = await services.tenants.resolve(request);
    return renderBlocks(request, reply, tenant);
  });

  app.post("/agenda/bloqueos", async (request, reply) => {
    const tenant = await services.tenants.resolve(request);
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      const input = parseInput(blockBody, body);
      await createBlock(tenant, blockDeps(), {
        fromLocal: `${input.desdeFecha}T${input.desdeHora}`,
        toLocal: `${input.hastaFecha}T${input.hastaHora}`,
        reason: input.motivo,
      });
    } catch (error) {
      if (error instanceof BlockConflictError) return replyBlockConflict(request, reply, tenant, error);
      if (error instanceof ValidationError && !wantsJson(request)) {
        const values: Record<string, string> = {};
        for (const [key, value] of Object.entries(body)) if (typeof value === "string" && key !== "_csrf") values[key] = value.slice(0, 200);
        return renderBlocks(request, reply, tenant, { status: 400, values, errors: error.fields ?? {} });
      }
      throw error;
    }
    return reply.redirect("/agenda/bloqueos", 303);
  });

  app.post("/agenda/bloqueos/espacio", async (request, reply) => {
    const tenant = await services.tenants.resolve(request);
    const { inicio } = parseInput(slotBody, request.body ?? {});
    try {
      await blockSlot(tenant, blockDeps(), inicio);
    } catch (error) {
      if (error instanceof BlockConflictError) return replyBlockConflict(request, reply, tenant, error);
      throw error;
    }
    return reply.redirect(`/agenda/dia/${inicio.slice(0, 10)}`, 303);
  });

  app.post("/agenda/bloqueos/:id/eliminar", async (request, reply) => {
    const tenant = await services.tenants.resolve(request);
    const { id } = parseInput(idParams, request.params);
    await removeBlock(tenant, blockDeps(), id);
    return reply.redirect("/agenda/bloqueos", 303);
  });

  // --- Configuración -------------------------------------------------------------------------------------------

  function sendConfigPage(
    request: FastifyRequest,
    reply: FastifyReply,
    status: number,
    page: { values: Record<string, string>; errors?: Readonly<Record<string, readonly string[]>>; isDefault: boolean; saved?: boolean },
  ): FastifyReply {
    return reply
      .code(status)
      .type("text/html; charset=utf-8")
      .send(
        configurationPage({
          csrf: app.csrf.tokenFor(request, reply),
          allowedTimezones: ALLOWED_TIMEZONES,
          ...page,
        }),
      );
  }

  app.get("/agenda/configuracion", async (request, reply) => {
    const tenant = await resolveDoctorOnly(request);
    const config = await loadSettings(tenant, services.db);
    if (wantsJson(request)) {
      return reply.send({
        isDefault: config.isDefault,
        settings: {
          slotMinutes: config.settings.slotMinutes,
          gapMinutes: config.settings.gapMinutes,
          timezone: config.settings.timezone,
          minNoticeHours: Math.floor(config.settings.minNoticeMinutes / 60),
          maxAdvanceDays: config.settings.maxAdvanceDays,
        },
        hours: config.hours.map((range) => ({ weekday: range.weekday, start: minutesText(range.startMinute), end: minutesText(range.endMinute) })),
      });
    }
    const saved = (request.query as Record<string, unknown> | undefined)?.guardado === "1";
    return sendConfigPage(request, reply, 200, { values: configFormValues(config), isDefault: config.isDefault, saved });
  });

  app.post("/agenda/configuracion", async (request, reply) => {
    // El contexto se resuelve antes de validar: recepción recibe 403 aunque el cuerpo sea inválido.
    const tenant = await resolveDoctorOnly(request);
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      const input = parseCalendarForm(body);
      await saveSettings(tenant, services.db, input, services.clock);
    } catch (error) {
      if (error instanceof ValidationError && !wantsJson(request)) {
        const current = await loadSettings(tenant, services.db);
        const values: Record<string, string> = {};
        for (const [key, value] of Object.entries(body)) if (typeof value === "string" && key !== "_csrf") values[key] = value.slice(0, 64);
        return sendConfigPage(request, reply, 400, { values, errors: error.fields ?? {}, isDefault: current.isDefault });
      }
      throw error;
    }
    return reply.redirect("/agenda/configuracion?guardado=1", 303);
  });
}
