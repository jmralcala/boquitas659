import type { PoolConnection } from "mysql2/promise";
import type { Db } from "../../db/pool.js";
import { ConflictError, NotFoundError, ValidationError } from "../../http/errors.js";
import { classifySlots, generateSlotsForDay, type SlotTime } from "../../lib/calendar-slots.js";
import type { Clock } from "../../lib/clock.js";
import type { StaffContext, TenantContext } from "../../lib/tenant.js";
import { daysBetweenLocalDates, isValidLocalDate, localToUtc, utcToLocal } from "../../lib/zoned-time.js";
import { enqueueEmail } from "../../mail/outbox.js";
import { findNotificationEmailForDoctor, findPatientForDoctor } from "../patients/patient-repository.js";
import { linkPatientToDoctor } from "../patients/link-service.js";
import { assertWithinAppointmentLimits, logCalendarAction } from "./action-log.js";
import { MAX_DAYS_AHEAD } from "./agenda-service.js";
import {
  cancelBookedAppointment,
  findAppointment,
  findOverlappingBooked,
  insertAppointment,
  listBookedInRange,
} from "./appointment-repository.js";
import { hasOverlappingBlock, listBlocksInRange } from "./block-repository.js";
import { withCalendarLock } from "./calendar-lock.js";
import { verifyTicket } from "./patient-picker.js";
import { loadSettings } from "./settings-repository.js";

export interface AppointmentDeps {
  db: Db;
  clock: Clock;
  /** Secreto de la aplicación para verificar los boletos del selector de pacientes. */
  ticketSecret: string;
}

export interface CreateAppointmentInput {
  /** Inicio del espacio en hora local del consultorio: `AAAA-MM-DDTHH:MM`. */
  startLocal: string;
  patientId: number;
  /** Boleto de la búsqueda por correo; obligatorio si el paciente aún no está vinculado con el médico. */
  ticket?: string | undefined;
}

const LOCAL_START = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/;

/** `AAAA-MM-DDTHH:MM` → fecha local y minutos del día; `null` si no es una fecha y hora reales. */
export function parseLocalStart(value: string): { date: string; minutes: number } | null {
  const match = LOCAL_START.exec(value);
  if (!match || !match[1] || !match[2] || !match[3]) return null;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours > 23 || minutes > 59 || !isValidLocalDate(match[1])) return null;
  return { date: match[1], minutes: hours * 60 + minutes };
}

function invalidStart(message = "Elige una fecha y hora válidas."): ValidationError {
  return new ValidationError({ inicio: [message] });
}

type SettingsExecutor = Parameters<typeof loadSettings>[1];

/**
 * Espacio de la configuración vigente que empieza en `startLocal`. Lanza `ValidationError` (400) si el inicio está mal
 * formado, la hora local no existe, está a más de 730 días o no es un espacio del horario (fuera de franja o desfasado).
 */
export async function resolveSlot(
  ctx: TenantContext,
  executor: SettingsExecutor,
  startLocal: string,
  now: Date,
): Promise<{ slot: SlotTime; timezone: string }> {
  const parsed = parseLocalStart(startLocal);
  if (!parsed) throw invalidStart();
  const { settings, hours } = await loadSettings(ctx, executor);
  const startUtc = localToUtc(settings.timezone, parsed.date, parsed.minutes);
  if (!startUtc) throw invalidStart("Esa hora no existe ese día (cambio de horario).");
  if (daysBetweenLocalDates(utcToLocal(settings.timezone, now).date, parsed.date) > MAX_DAYS_AHEAD) {
    throw invalidStart(`Solo se puede agendar hasta ${MAX_DAYS_AHEAD} días hacia adelante.`);
  }
  const slot = generateSlotsForDay(settings, hours, parsed.date).find((candidate) => candidate.startUtc.getTime() === startUtc.getTime());
  if (!slot) throw invalidStart("Ese horario no existe en la agenda del consultorio.");
  return { slot, timezone: settings.timezone };
}

/**
 * Espacio libre y futuro que empieza en `startLocal` (lo que ofrece la pantalla de nueva cita), o `null` si ya no lo es
 * (no existe en el horario, ya pasó, está ocupado o bloqueado). Un formato inválido lanza `ValidationError` (400).
 */
export async function describeFreeSlot(
  ctx: StaffContext,
  db: Db,
  startLocal: string,
  now: Date,
): Promise<{ slot: SlotTime; timezone: string } | null> {
  if (parseLocalStart(startLocal) === null) throw invalidStart();
  let resolved: { slot: SlotTime; timezone: string };
  try {
    resolved = await resolveSlot(ctx, db, startLocal, now);
  } catch (error) {
    if (error instanceof ValidationError) return null; // el espacio no existe en el horario actual
    throw error;
  }
  const { slot } = resolved;
  const [appointments, blocks] = await Promise.all([
    listBookedInRange(ctx, db, slot.startUtc, slot.endUtc),
    listBlocksInRange(ctx, db, slot.startUtc, slot.endUtc),
  ]);
  const [classified] = classifySlots([slot], appointments, blocks, now);
  return classified?.state === "free" ? resolved : null;
}

/**
 * Validación común a TODO camino que agenda (personal o paciente): el inicio es un espacio de la configuración vigente,
 * futuro, sin cita vigente solapada y sin bloqueo solapado. Se llama dentro de `withCalendarLock` con su conexión.
 * Lanza `ValidationError` (400) si el espacio no existe y `ConflictError` `slot_unavailable` (409) si ya pasó,
 * está ocupado o bloqueado.
 */
export async function assertSlotBookable(
  ctx: TenantContext,
  connection: PoolConnection,
  startLocal: string,
  now: Date,
): Promise<{ slot: SlotTime; timezone: string }> {
  const resolved = await resolveSlot(ctx, connection, startLocal, now);
  const { slot } = resolved;
  if (slot.startUtc.getTime() <= now.getTime()) throw new ConflictError("Ese espacio ya pasó.", "slot_unavailable");
  if (await findOverlappingBooked(ctx, connection, slot.startUtc, slot.endUtc)) {
    throw new ConflictError("Ese espacio ya está ocupado.", "slot_unavailable");
  }
  if (await hasOverlappingBlock(ctx, connection, slot.startUtc, slot.endUtc)) {
    throw new ConflictError("Ese espacio está bloqueado.", "slot_unavailable");
  }
  return resolved;
}

/**
 * Crea una cita (médico o recepción). Todo ocurre en UNA transacción bajo el bloqueo de la fila del médico: valida que el
 * inicio sea un espacio de la configuración vigente, futuro, sin cita vigente solapada y sin bloqueo solapado; comprueba
 * que el paciente sea alcanzable (ya vinculado, o con un boleto firmado válido, en cuyo caso se crea el vínculo en la misma
 * transacción); inserta la cita; encola el correo al paciente y registra la acción. El índice único sobre el inicio de la
 * cita vigente es el respaldo si algún camino futuro olvidara el bloqueo.
 *
 * El personal NO pasa por las anticipaciones del paciente: solo por «espacio futuro y libre».
 */
export async function createAppointment(
  ctx: StaffContext,
  deps: AppointmentDeps,
  input: CreateAppointmentInput,
): Promise<{ id: number; startUtc: Date; endUtc: Date }> {
  return withCalendarLock(ctx, deps.db, async (connection) => {
    const now = deps.clock.now();
    // Límite por persona y por paciente (cada cita manda un correo): bajo el bloqueo, así que las ráfagas no lo eluden.
    await assertWithinAppointmentLimits(ctx, connection, now, input.patientId);
    const { slot } = await assertSlotBookable(ctx, connection, input.startLocal, now);

    // Un paciente es alcanzable si ya está vinculado con ESTE médico o si trae un boleto firmado para este médico y actor.
    let newlyLinked = false;
    const linked = await findPatientForDoctor(ctx, connection, input.patientId);
    if (!linked) {
      if (!input.ticket || !verifyTicket(deps.ticketSecret, ctx, input.patientId, input.ticket, now)) throw new NotFoundError();
      // Lanza NotFoundError si el paciente no existe o si su cuenta revocó el vínculo con este consultorio.
      const link = await linkPatientToDoctor(ctx, connection, input.patientId, { origin: "office", createdByUserId: ctx.actor.userId });
      newlyLinked = link.created;
    }

    let appointmentId: number;
    try {
      appointmentId = await insertAppointment(ctx, connection, { patientId: input.patientId, startUtc: slot.startUtc, endUtc: slot.endUtc, now });
    } catch (error) {
      // 1062 = el índice único de la cita vigente (respaldo de la invariante).
      if ((error as { errno?: number }).errno === 1062) throw new ConflictError("Ese espacio ya está ocupado.", "slot_unavailable");
      throw error;
    }

    const to = await findNotificationEmailForDoctor(ctx, connection, input.patientId);
    if (to) await enqueueEmail(connection, { template: "appointment_created", to, payload: { appointmentId } }, deps.clock);
    // La cuenta se entera de que este consultorio ya ve sus datos de contacto y de cómo revocarlo.
    if (to && newlyLinked) await enqueueEmail(connection, { template: "patient_linked_by_office", to, payload: { appointmentId } }, deps.clock);
    await logCalendarAction(ctx, connection, { action: "appointment_created", outcome: "ok", appointmentId, at: now });
    return { id: appointmentId, startUtc: slot.startUtc, endUtc: slot.endUtc };
  });
}

/**
 * Cancela una cita futura (médico o recepción) en una transacción bajo el bloqueo del médico: libera el espacio de
 * inmediato, registra quién cancela y cuándo, encola el aviso al paciente y registra la acción. Una cita de otro
 * médico o inexistente es `NotFoundError`; una ya cancelada o cuya hora terminó es `ConflictError` y no repite avisos.
 */
export async function cancelAppointment(ctx: StaffContext, deps: AppointmentDeps, id: number): Promise<void> {
  await withCalendarLock(ctx, deps.db, async (connection) => {
    const now = deps.clock.now();
    await assertWithinAppointmentLimits(ctx, connection, now, null);
    const appointment = await findAppointment(ctx, connection, id);
    if (!appointment) throw new NotFoundError();
    if (appointment.status !== "booked") throw new ConflictError("Esa cita ya estaba cancelada.", "appointment_not_cancelable");
    if (appointment.endUtc.getTime() <= now.getTime()) {
      throw new ConflictError("Esa cita ya pasó: no hay un espacio que liberar.", "appointment_not_cancelable");
    }
    if (!(await cancelBookedAppointment(ctx, connection, id, now))) {
      throw new ConflictError("Esa cita ya no se puede cancelar.", "appointment_not_cancelable");
    }
    const to = await findNotificationEmailForDoctor(ctx, connection, appointment.patientId);
    if (to) await enqueueEmail(connection, { template: "appointment_cancelled", to, payload: { appointmentId: id } }, deps.clock);
    await logCalendarAction(ctx, connection, { action: "appointment_cancelled", outcome: "ok", appointmentId: id, at: now });
  });
}
