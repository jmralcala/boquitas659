import type { Pool, PoolConnection } from "mysql2/promise";
import type { Db } from "../../db/pool.js";
import { ConflictError, NotFoundError, TooManyAttemptsError } from "../../http/errors.js";
import type { Clock } from "../../lib/clock.js";
import { createPatientContext } from "../../lib/tenant.js";
import { enqueueEmail } from "../../mail/outbox.js";
import { logCalendarAction } from "../calendar/action-log.js";
import { cancelBookedAppointment } from "../calendar/appointment-repository.js";
import { countPatientCancellations, findAppointmentForPatients, listAppointmentsForPatients, type PatientAppointmentRow } from "./account-appointments.js";
import { withCalendarLock } from "../calendar/calendar-lock.js";
import { findAccountByUserId, findAccountEmail, listAccountPatientIds, listPatientsByAccount } from "../patients/patient-repository.js";
import { findDoctorAccountEmail } from "./site-repository.js";

type Reader = Pick<Pool, "execute"> | Pick<PoolConnection, "execute">;

/** Cuánto historial se muestra en «Mis citas». */
export const HISTORY_DAYS = 90;

/** Límite de cancelaciones por cuenta y hora (contadas desde `appointment`). */
export const CANCELLATION_LIMIT_PER_HOUR = 10;
const WINDOW_MS = 60 * 60_000;

export interface PatientAppointmentItem {
  id: number;
  doctorId: number;
  doctorName: string;
  patientName: string;
  startUtc: Date;
  endUtc: Date;
  timezone: string;
  status: "booked" | "cancelled";
  /** Agendada y su hora aún no termina. */
  live: boolean;
  /** Vigente y todavía dentro del plazo en que el paciente puede cancelar en línea. */
  cancelable: boolean;
  cancelDeadline: Date;
  officePhone: string | null;
  address: string | null;
}

export interface PatientAppointmentList {
  upcoming: PatientAppointmentItem[];
  history: PatientAppointmentItem[];
}

export interface PatientAppointmentDeps {
  db: Db;
  clock: Clock;
}

function toItem(row: PatientAppointmentRow, names: ReadonlyMap<number, string>, now: Date): PatientAppointmentItem {
  const cancelDeadline = new Date(row.startUtc.getTime() - row.cancelNoticeHours * 3_600_000);
  const live = row.status === "booked" && row.endUtc.getTime() > now.getTime();
  return {
    id: row.id,
    doctorId: row.doctorId,
    doctorName: row.doctorName,
    patientName: names.get(row.patientId) ?? "Paciente",
    startUtc: row.startUtc,
    endUtc: row.endUtc,
    timezone: row.timezone,
    status: row.status,
    live,
    cancelable: live && now.getTime() <= cancelDeadline.getTime(),
    cancelDeadline,
    officePhone: row.officePhone,
    address: row.address,
  };
}

async function accountOf(executor: Reader, userId: number): Promise<{ accountId: number; patientIds: number[]; names: Map<number, string> }> {
  const account = await findAccountByUserId(executor, userId);
  if (!account) throw new NotFoundError();
  const patients = await listPatientsByAccount(executor, account.id);
  return { accountId: account.id, patientIds: await listAccountPatientIds(executor, account.id), names: new Map(patients.map((patient) => [patient.id, patient.fullName])) };
}

/** «Mis citas»: las de las personas de la cuenta (titular y adicionales) con cualquier consultorio. */
export async function listForAccount(db: Reader, userId: number, now: Date): Promise<PatientAppointmentList> {
  const { patientIds, names } = await accountOf(db, userId);
  const since = new Date(now.getTime() - HISTORY_DAYS * 86_400_000);
  const items = (await listAppointmentsForPatients(db, patientIds, since)).map((row) => toItem(row, names, now));
  const upcoming = items.filter((item) => item.status === "booked" && item.endUtc.getTime() > now.getTime());
  const history = items.filter((item) => !upcoming.includes(item)).sort((a, b) => b.startUtc.getTime() - a.startUtc.getTime());
  return { upcoming, history };
}

/** Una cita de la cuenta; `NotFoundError` si es de otra cuenta o no existe. */
export async function getForAccount(db: Reader, userId: number, appointmentId: number, now: Date): Promise<PatientAppointmentItem> {
  const { patientIds, names } = await accountOf(db, userId);
  const row = await findAppointmentForPatients(db, patientIds, appointmentId);
  if (!row) throw new NotFoundError();
  return toItem(row, names, now);
}

/**
 * El paciente cancela una cita de su cuenta. En UNA transacción bajo el bloqueo del médico de la cita: la cita sigue
 * vigente, falta al menos el límite del consultorio (inclusivo), la cuenta no excede 10 cancelaciones por hora; libera
 * el horario, registra quién y cuándo, y encola el aviso al médico y la constancia al paciente.
 *
 * No exige que el micrositio siga publicado ni que el médico siga aprobado: quien ya tiene una cita siempre puede
 * cancelarla dentro del plazo. Fuera del plazo se le indica el teléfono del consultorio.
 */
export async function cancelAsPatient(
  deps: PatientAppointmentDeps,
  userId: number,
  appointmentId: number,
  options: { reason?: "revoked" } = {},
): Promise<{ id: number }> {
  const { patientIds } = await accountOf(deps.db, userId);
  const found = await findAppointmentForPatients(deps.db, patientIds, appointmentId);
  if (!found) throw new NotFoundError();
  const ctx = createPatientContext(found.doctorId, userId);

  return withCalendarLock(ctx, deps.db, async (connection) => {
    const now = deps.clock.now();
    const current = await findAppointmentForPatients(connection, patientIds, appointmentId);
    if (!current) throw new NotFoundError();
    if (current.status !== "booked") throw new ConflictError("Esa cita ya estaba cancelada.", "appointment_not_cancelable");
    if (current.endUtc.getTime() <= now.getTime()) throw new ConflictError("Esa cita ya pasó.", "appointment_not_cancelable");

    // Una cancelación por revocación del vínculo no está sujeta al plazo ni al límite (es una decisión sobre los datos).
    if (options.reason !== "revoked") {
      const deadline = current.startUtc.getTime() - current.cancelNoticeHours * 3_600_000;
      if (now.getTime() > deadline) {
        const contact = current.officePhone ? ` Llama al consultorio: ${current.officePhone}.` : " Comunícate directamente con el consultorio.";
        throw new ConflictError(`Ya pasó el plazo para cancelar en línea (hasta ${current.cancelNoticeHours} horas antes de la cita).${contact}`, "cancellation_window_closed");
      }
      const recent = await countPatientCancellations(connection, userId, new Date(now.getTime() - WINDOW_MS));
      if (recent.count >= CANCELLATION_LIMIT_PER_HOUR) {
        const wait = recent.oldest ? recent.oldest.getTime() + WINDOW_MS - now.getTime() : WINDOW_MS;
        throw new TooManyAttemptsError(Math.max(1000, wait));
      }
    }

    if (!(await cancelBookedAppointment(ctx, connection, appointmentId, now))) {
      throw new ConflictError("Esa cita ya no se puede cancelar.", "appointment_not_cancelable");
    }
    await logCalendarAction(ctx, connection, { action: "appointment_cancelled", outcome: "ok", appointmentId, at: now });

    const patientEmail = await findAccountEmail(connection, userId);
    if (patientEmail) await enqueueEmail(connection, { template: "appointment_cancelled_by_patient", to: patientEmail, payload: { appointmentId } }, deps.clock);
    const doctorEmail = await findDoctorAccountEmail(ctx, connection);
    const payload: Record<string, string | number> = options.reason ? { appointmentId, reason: options.reason } : { appointmentId };
    if (doctorEmail) await enqueueEmail(connection, { template: "doctor_appointment_cancelled", to: doctorEmail, payload }, deps.clock);
    return { id: appointmentId };
  });
}
