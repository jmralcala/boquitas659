import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import type { Db } from "../../db/pool.js";
import { ConflictError, ForbiddenError, NotFoundError, SiteUnavailableError, TooManyAttemptsError, ValidationError } from "../../http/errors.js";
import type { Clock } from "../../lib/clock.js";
import type { TenantContext } from "../../lib/tenant.js";
import { logCalendarAction } from "../calendar/action-log.js";
import { assertSlotBookable, resolveSlot } from "../calendar/appointment-service.js";
import { insertAppointment } from "../calendar/appointment-repository.js";
import { validatePatientBookingWindow } from "../calendar/availability.js";
import { withCalendarLock } from "../calendar/calendar-lock.js";
import { loadSettings } from "../calendar/settings-repository.js";
import { linkPatientToDoctor } from "../patients/link-service.js";
import { enqueueEmail } from "../../mail/outbox.js";
import { findAccountByUserId, findNotificationEmailForDoctor, findPatientOfAccount } from "../patients/patient-repository.js";
import { hasActiveAuthorization, recordAuthorization } from "./authorization.js";
import { findDoctorAccountEmail, isAcceptingBookings } from "./site-repository.js";

export interface BookingDeps {
  db: Db;
  clock: Clock;
}

export interface ReserveInput {
  /** Inicio del espacio en hora local del consultorio: `AAAA-MM-DDTHH:MM`. */
  startLocal: string;
  /** Paciente de la cuenta: el titular o uno adicional (hijo). */
  patientId: number;
  /** El paciente marcó la casilla de autorización de datos (solo se exige si no hay una autorización activa). */
  authorize: boolean;
}

export interface ReserveResult {
  id: number;
  startUtc: Date;
  endUtc: Date;
  /** `false` si era un doble envío y se devuelve la cita que ya existía. */
  created: boolean;
}

/** Límites de abuso de la reserva (por cuenta; los de IP están en la ruta). */
export const BOOKING_LIMITS = {
  /** Reservas por cuenta en una hora, con cualquier consultorio. */
  perAccountPerHour: 5,
  /** Citas vigentes por paciente con un mismo consultorio. */
  activePerPatient: 3,
  windowMs: 60 * 60_000,
} as const;

/**
 * Reserva de un PACIENTE. Todo ocurre en UNA transacción bajo el bloqueo de la fila del médico (principio III), en este
 * orden: (1) el consultorio acepta reservas; (2) el paciente es de la cuenta de quien reserva; (3) doble envío; (4)
 * límites por cuenta; (5) horario existente, futuro y libre y anticipaciones del médico; (6) autorización de datos y
 * vínculo; (7) inserción de la cita y registro de la acción. El índice único del inicio de la cita vigente es el
 * respaldo si algún camino olvidara el bloqueo.
 *
 * El médico sale del contexto (resuelto del nombre del enlace en el servidor), nunca de un dato del cliente.
 */
export async function reserveAsPatient(ctx: TenantContext, deps: BookingDeps, input: ReserveInput): Promise<ReserveResult> {
  if (ctx.actor.kind !== "patient") throw new ForbiddenError();
  const userId = ctx.actor.userId;

  return withCalendarLock(ctx, deps.db, async (connection) => {
    const now = deps.clock.now();

    if (!(await isAcceptingBookings(ctx, connection))) throw new SiteUnavailableError();

    const account = await findAccountByUserId(connection, userId);
    if (!account) throw new NotFoundError();
    if (!(await findPatientOfAccount(connection, account.id, input.patientId))) throw new NotFoundError();

    // Formato y existencia del espacio (400) antes de los límites: un envío inválido no consume cupo.
    const { slot } = await resolveSlot(ctx, connection, input.startLocal, now);

    // Doble envío: la misma cuenta ya agendó a este paciente en este espacio.
    const duplicate = await findOwnBooking(ctx, connection, userId, input.patientId, slot.startUtc);
    if (duplicate) return { id: duplicate.id, startUtc: duplicate.startUtc, endUtc: duplicate.endUtc, created: false };

    await assertWithinBookingLimits(ctx, connection, now, userId, input.patientId);

    await assertSlotBookable(ctx, connection, input.startLocal, now);
    const { settings } = await loadSettings(ctx, connection);
    if (!validatePatientBookingWindow(settings, slot.startUtc, now).ok) {
      throw new ConflictError("Ese horario ya no está disponible.", "slot_unavailable");
    }

    // Se evalúa ANTES de vincular: reactivar un vínculo revocado no debe hacer «activa» una autorización anterior.
    const authorized = await hasActiveAuthorization(ctx, connection, account.id);
    if (!authorized && !input.authorize) {
      throw new ValidationError({ autorizo: ["Debes autorizar que el consultorio vea los datos de contacto del paciente para poder agendar."] });
    }
    await linkPatientToDoctor(ctx, connection, input.patientId, { origin: "patient", createdByUserId: userId });
    if (!authorized) await recordAuthorization(ctx, connection, { accountId: account.id, now });

    let appointmentId: number;
    try {
      appointmentId = await insertAppointment(ctx, connection, { patientId: input.patientId, startUtc: slot.startUtc, endUtc: slot.endUtc, now });
    } catch (error) {
      // 1062 = el índice único de la cita vigente (respaldo de la invariante).
      if ((error as { errno?: number }).errno === 1062) throw new ConflictError("Ese horario ya no está disponible.", "slot_unavailable");
      throw error;
    }
    await logCalendarAction(ctx, connection, { action: "appointment_created", outcome: "ok", appointmentId, at: now });

    // Correos en la MISMA transacción: confirmación a la cuenta del paciente (con enlace) y aviso al correo del médico.
    const patientEmail = await findNotificationEmailForDoctor(ctx, connection, input.patientId);
    if (patientEmail) await enqueueEmail(connection, { template: "appointment_created", to: patientEmail, payload: { appointmentId } }, deps.clock);
    const doctorEmail = await findDoctorAccountEmail(ctx, connection);
    if (doctorEmail) await enqueueEmail(connection, { template: "doctor_appointment_booked", to: doctorEmail, payload: { appointmentId } }, deps.clock);
    return { id: appointmentId, startUtc: slot.startUtc, endUtc: slot.endUtc, created: true };
  });
}

async function findOwnBooking(
  ctx: TenantContext,
  connection: PoolConnection,
  userId: number,
  patientId: number,
  startUtc: Date,
): Promise<{ id: number; startUtc: Date; endUtc: Date } | null> {
  const [rows] = await connection.execute<RowDataPacket[]>(
    `SELECT id, start_utc, end_utc FROM appointment
      WHERE doctor_id = ? AND start_utc = ? AND status = 'booked' AND patient_id = ? AND created_by_user_id = ? AND created_by_role = 'patient'
      LIMIT 1`,
    [ctx.doctorId, startUtc, patientId, userId],
  );
  const row = rows[0];
  return row ? { id: Number(row.id), startUtc: row.start_utc as Date, endUtc: row.end_utc as Date } : null;
}

/**
 * Límites por cuenta, contados desde `appointment` (no hace falta otra tabla) y bajo el bloqueo del médico, así que una
 * ráfaga simultánea los respeta. Lanza `TooManyAttemptsError` (429) o `ConflictError` `appointment_limit` (409).
 */
async function assertWithinBookingLimits(ctx: TenantContext, connection: PoolConnection, now: Date, userId: number, patientId: number): Promise<void> {
  const since = new Date(now.getTime() - BOOKING_LIMITS.windowMs);
  const [recent] = await connection.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM appointment
      WHERE created_by_user_id = ? AND created_by_role = 'patient' AND created_at >= ?`,
    [userId, since],
  );
  if (Number(recent[0]?.n ?? 0) >= BOOKING_LIMITS.perAccountPerHour) {
    const oldest = recent[0]?.oldest;
    const wait = oldest instanceof Date ? oldest.getTime() + BOOKING_LIMITS.windowMs - now.getTime() : BOOKING_LIMITS.windowMs;
    throw new TooManyAttemptsError(Math.max(1000, wait));
  }

  const [active] = await connection.execute<RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM appointment WHERE doctor_id = ? AND patient_id = ? AND status = 'booked' AND end_utc > ?",
    [ctx.doctorId, patientId, now],
  );
  if (Number(active[0]?.n ?? 0) >= BOOKING_LIMITS.activePerPatient) {
    throw new ConflictError(
      `Ya tienes ${BOOKING_LIMITS.activePerPatient} citas vigentes con este consultorio. Cancela una o espera a que pase para agendar otra.`,
      "appointment_limit",
    );
  }
}
