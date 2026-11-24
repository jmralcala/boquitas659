import type { Db } from "../../db/pool.js";
import { ConflictError, ForbiddenError, NotFoundError, SiteUnavailableError, ValidationError } from "../../http/errors.js";
import type { AppointmentSpan } from "../../lib/calendar-slots.js";
import type { Clock } from "../../lib/clock.js";
import type { TenantContext } from "../../lib/tenant.js";
import { findNearestUrgentSlot } from "../../lib/urgent-slot.js";
import { formatLocalInstant } from "../../lib/zoned-time.js";
import { logCalendarAction } from "../calendar/action-log.js";
import { assertSlotBookable, STAFF_SLOT_KINDS } from "../calendar/appointment-service.js";
import { insertAppointment, listBookedSpansInRange } from "../calendar/appointment-repository.js";
import { listBlockSpansInRange } from "../calendar/block-repository.js";
import { withCalendarLock } from "../calendar/calendar-lock.js";
import { loadSettings } from "../calendar/settings-repository.js";
import { enqueueEmail } from "../../mail/outbox.js";
import { linkPatientToDoctor } from "../patients/link-service.js";
import { findAccountByUserId, findNotificationEmailForDoctor, findPatientOfAccount } from "../patients/patient-repository.js";
import { hasActiveAuthorization, recordAuthorization } from "../site/authorization.js";
import { findDoctorAccountEmail, isAcceptingBookings } from "../site/site-repository.js";
import { categoryById, type CategoryId } from "./triage-content.js";
import { assertWithinUrgentLimits, findRecentOwnUrgent } from "./urgent-limits.js";

export interface UrgentDeps {
  db: Db;
  clock: Clock;
}

export interface RequestUrgentInput {
  /** Paciente de la cuenta: el titular o uno adicional (hijo). */
  patientId: number;
  /** Solo se usa para escoger la ventana de tiempo: NO se guarda en ninguna parte. */
  category: CategoryId;
  /** El paciente marcó la casilla de autorización de datos (solo se exige si no hay una autorización activa). */
  authorize: boolean;
}

export type UrgentResult =
  /** `created: false` si era un doble envío y se devuelve la urgencia que ya existía. */
  | { kind: "scheduled"; id: number; startUtc: Date; endUtc: Date; created: boolean }
  /** No hay espacio libre dentro de la ventana del nivel: no se crea nada. */
  | { kind: "no_space" };

/** Intentos de asignación si el espacio hallado ya no pasa la validación común (no debería ocurrir bajo el bloqueo). */
const MAX_ATTEMPTS = 3;

/**
 * Solicitud de urgencia de un PACIENTE. Todo ocurre en UNA transacción bajo el bloqueo de la fila del médico (principio
 * III): el consultorio acepta reservas, el paciente es de la cuenta, hay autorización de datos, se busca el espacio libre más
 * próximo dentro de la ventana del nivel (con la anticipación mínima de urgencias del médico), se revalida con la validación
 * común de la agenda, se vincula, se inserta la cita con `kind = 'urgent'` y se registra la acción. El índice único de la
 * cita vigente es el respaldo.
 *
 * La categoría solo elige la ventana: no se escribe en la cita, el vínculo, la autorización ni el registro (principio I).
 * El médico sale del contexto (resuelto del nombre del enlace en el servidor), nunca de un dato del cliente.
 */
export async function requestUrgent(ctx: TenantContext, deps: UrgentDeps, input: RequestUrgentInput): Promise<UrgentResult> {
  if (ctx.actor.kind !== "patient") throw new ForbiddenError();
  const userId = ctx.actor.userId;
  // Falla antes de abrir la transacción si la categoría no es de la lista (nunca llega a la base de datos).
  const windowMs = categoryById(input.category).windowHours * 3_600_000;

  return withCalendarLock(ctx, deps.db, async (connection) => {
    const now = deps.clock.now();

    if (!(await isAcceptingBookings(ctx, connection))) throw new SiteUnavailableError();

    const account = await findAccountByUserId(connection, userId);
    if (!account) throw new NotFoundError();
    if (!(await findPatientOfAccount(connection, account.id, input.patientId))) throw new NotFoundError();

    // Doble envío: la misma cuenta ya pidió esta urgencia hace un momento. Se devuelve esa cita sin contar de nuevo.
    const duplicate = await findRecentOwnUrgent(ctx, connection, { userId, patientId: input.patientId, now });
    if (duplicate) return { kind: "scheduled", ...duplicate, created: false };
    // Una urgencia activa por paciente y 3 solicitudes por cuenta cada 24 h (antes de la autorización y de la búsqueda).
    await assertWithinUrgentLimits(ctx, connection, { userId, patientId: input.patientId, now });

    // Se evalúa ANTES de vincular: reactivar un vínculo revocado no debe hacer «activa» una autorización anterior.
    const authorized = await hasActiveAuthorization(ctx, connection, account.id);
    if (!authorized && !input.authorize) {
      throw new ValidationError({ autorizo: ["Debes autorizar que el consultorio vea los datos de contacto del paciente para poder agendar."] });
    }

    const { settings, hours } = await loadSettings(ctx, connection);
    const latest = new Date(now.getTime() + windowMs);
    // Una sola lectura de citas y de bloqueos de todo el rango (más la duración de un espacio, que puede terminar después).
    const readTo = new Date(latest.getTime() + settings.slotMinutes * 60_000);
    const [booked, blocks] = await Promise.all([listBookedSpansInRange(ctx, connection, now, readTo), listBlockSpansInRange(ctx, connection, now, readTo)]);

    const taken: AppointmentSpan[] = [...booked];
    // Sin espacio: la transacción se CONFIRMA (no se lanza una excepción) para que la solicitud quede contada, sin categoría.
    const noSpace = async (): Promise<UrgentResult> => {
      await logCalendarAction(ctx, connection, { action: "urgent_requested", outcome: "rejected", at: now });
      return { kind: "no_space" };
    };
    let linked = false; // el vínculo y la autorización se registran una sola vez aunque haya que reintentar con otro espacio
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const slot = findNearestUrgentSlot({
        settings,
        hours,
        appointments: taken,
        blocks,
        now,
        windowHours: windowMs / 3_600_000,
        minNoticeMinutes: settings.urgentMinNoticeMinutes,
      });
      if (!slot) return noSpace();

      // Misma validación que usa la agenda del personal y la reserva convencional (horario real, futuro, sin solape ni bloqueo).
      try {
        await assertSlotBookable(ctx, connection, formatLocalInstant(settings.timezone, slot.startUtc), now, { kinds: STAFF_SLOT_KINDS });
      } catch (error) {
        if (error instanceof ConflictError || error instanceof ValidationError) {
          taken.push({ id: -1 - attempt, startUtc: slot.startUtc, endUtc: slot.endUtc });
          continue;
        }
        throw error;
      }

      if (!linked) {
        await linkPatientToDoctor(ctx, connection, input.patientId, { origin: "patient", createdByUserId: userId });
        if (!authorized) await recordAuthorization(ctx, connection, { accountId: account.id, now });
        linked = true;
      }

      let appointmentId: number;
      try {
        appointmentId = await insertAppointment(ctx, connection, { patientId: input.patientId, startUtc: slot.startUtc, endUtc: slot.endUtc, now, kind: "urgent" });
      } catch (error) {
        // 1062 = el índice único de la cita vigente (respaldo de la invariante): se intenta con el siguiente espacio.
        if ((error as { errno?: number }).errno === 1062) {
          taken.push({ id: -1 - attempt, startUtc: slot.startUtc, endUtc: slot.endUtc });
          continue;
        }
        throw error;
      }
      await logCalendarAction(ctx, connection, { action: "urgent_requested", outcome: "ok", appointmentId, at: now });

      // Correos en la MISMA transacción: confirmación al paciente (sin categoría) y aviso al correo del médico (no recepción), que
      // es el ÚNICO lugar donde viaja la categoría; el outbox la elimina al enviarse, cancelarse, abandonarse o a las 24 h.
      const patientEmail = await findNotificationEmailForDoctor(ctx, connection, input.patientId);
      if (patientEmail) await enqueueEmail(connection, { template: "appointment_created", to: patientEmail, payload: { appointmentId } }, deps.clock);
      const doctorEmail = await findDoctorAccountEmail(ctx, connection);
      if (doctorEmail) await enqueueEmail(connection, { template: "doctor_urgent_notice", to: doctorEmail, payload: { appointmentId, category: input.category } }, deps.clock);
      return { kind: "scheduled", id: appointmentId, startUtc: slot.startUtc, endUtc: slot.endUtc, created: true };
    }
    return noSpace();
  });
}
