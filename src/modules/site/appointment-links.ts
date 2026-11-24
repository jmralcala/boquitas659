import type { RowDataPacket } from "mysql2/promise";
import type { Db } from "../../db/pool.js";
import type { Clock } from "../../lib/clock.js";
import { DEFAULT_TIMEZONE } from "../../lib/zoned-time.js";
import type { OneTimeTokenService, TokenPurpose } from "../auth/one-time-tokens.js";
import type { SessionData } from "../auth/sessions.js";
import { findAccountByUserId, findPatientOfAccount } from "../patients/patient-repository.js";

/** Los dos propósitos de enlace de una cita: cada uno tiene su propio token y ninguno invalida al otro. */
const LINK_PURPOSES: readonly TokenPurpose[] = ["appointment_confirmation", "appointment_reminder"];

/** Horas por defecto del límite de cancelación si el médico aún no guardó su configuración. */
const DEFAULT_CANCEL_NOTICE_HOURS = 24;

export interface AppointmentSummary {
  appointmentId: number;
  doctorName: string;
  address: string | null;
  officePhone: string | null;
  patientName: string;
  startUtc: Date;
  endUtc: Date;
  timezone: string;
  /** El paciente todavía puede cancelar (antes del límite que fijó el médico). */
  cancelable: boolean;
  /** Último instante en que el paciente puede cancelar. */
  cancelDeadline: Date;
}

export type LinkResolution =
  /** Token inválido, vencido, manipulado, de otra cuenta, o cita cancelada o ya iniciada: SIEMPRE la misma respuesta. */
  | { kind: "gone" }
  /** El token es válido pero no hay sesión de paciente: se pide iniciar sesión y se regresa al mismo enlace. */
  | { kind: "login_required" }
  | { kind: "summary"; summary: AppointmentSummary };

export interface AppointmentLinks {
  /** ¿El token apunta a una cita vigente y futura? No consume nada y no revela nada de la cita. */
  isLive(token: string): Promise<boolean>;
  /** Valida el enlace SIN consumirlo ni cambiar la cita; con la sesión de la cuenta dueña devuelve el resumen. */
  resolve(token: string, auth: SessionData | null): Promise<LinkResolution>;
  /** Marca como usado el token (tras una cancelación hecha desde el enlace); un token inexistente se ignora. */
  consume(token: string): Promise<void>;
}

export interface AppointmentLinksDeps {
  db: Db;
  tokens: OneTimeTokenService;
  clock: Clock;
}

interface LiveAppointment {
  id: number;
  patientId: number;
  startUtc: Date;
  endUtc: Date;
  doctorName: string;
  officePhone: string | null;
  address: string | null;
  timezone: string;
  cancelNoticeHours: number;
}

export function createAppointmentLinks(deps: AppointmentLinksDeps): AppointmentLinks {
  /** La cita del token si sigue vigente (agendada) y su hora no ha llegado; `null` en cualquier otro caso. */
  async function liveAppointment(token: string): Promise<LiveAppointment | null> {
    let appointmentId: number | null = null;
    for (const purpose of LINK_PURPOSES) {
      const subject = await deps.tokens.peek(token, purpose);
      if (subject?.appointmentId) {
        appointmentId = subject.appointmentId;
        break;
      }
    }
    if (appointmentId === null) return null;

    const [rows] = await deps.db.execute<RowDataPacket[]>(
      `SELECT a.id, a.patient_id, a.start_utc, a.end_utc, d.full_name AS doctor_name, d.office_phone, ds.address,
              COALESCE(cs.timezone, ?) AS timezone, COALESCE(cs.cancel_notice_hours, ?) AS cancel_notice_hours
         FROM appointment a
         JOIN doctor d ON d.id = a.doctor_id
         LEFT JOIN doctor_site ds ON ds.doctor_id = a.doctor_id
         LEFT JOIN calendar_settings cs ON cs.doctor_id = a.doctor_id
        WHERE a.id = ? AND a.status = 'booked' AND a.start_utc > ?`,
      [DEFAULT_TIMEZONE, DEFAULT_CANCEL_NOTICE_HOURS, appointmentId, deps.clock.now()],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: Number(row.id),
      patientId: Number(row.patient_id),
      startUtc: row.start_utc as Date,
      endUtc: row.end_utc as Date,
      doctorName: String(row.doctor_name),
      officePhone: row.office_phone !== null && /^\d{10}$/.test(String(row.office_phone)) ? String(row.office_phone) : null,
      address: row.address === null ? null : String(row.address),
      timezone: String(row.timezone),
      cancelNoticeHours: Number(row.cancel_notice_hours),
    };
  }

  return {
    async consume(token) {
      for (const purpose of LINK_PURPOSES) await deps.tokens.consume(token, purpose);
    },

    async isLive(token) {
      return (await liveAppointment(token)) !== null;
    },

    async resolve(token, auth) {
      const appointment = await liveAppointment(token);
      if (!appointment) return { kind: "gone" };
      if (auth === null) return { kind: "login_required" };
      // Con sesión: solo la cuenta dueña del paciente de la cita ve el resumen; cualquier otra recibe lo mismo que un token inválido.
      if (auth.role !== "patient" || (auth.mfaEnabled && !auth.mfaVerified)) return { kind: "gone" };
      const account = await findAccountByUserId(deps.db, auth.userId);
      const patient = account ? await findPatientOfAccount(deps.db, account.id, appointment.patientId) : null;
      if (!patient) return { kind: "gone" };

      const cancelDeadline = new Date(appointment.startUtc.getTime() - appointment.cancelNoticeHours * 3_600_000);
      return {
        kind: "summary",
        summary: {
          appointmentId: appointment.id,
          doctorName: appointment.doctorName,
          address: appointment.address,
          officePhone: appointment.officePhone,
          patientName: patient.fullName,
          startUtc: appointment.startUtc,
          endUtc: appointment.endUtc,
          timezone: appointment.timezone,
          cancelable: deps.clock.now().getTime() <= cancelDeadline.getTime(),
          cancelDeadline,
        },
      };
    },
  };
}
