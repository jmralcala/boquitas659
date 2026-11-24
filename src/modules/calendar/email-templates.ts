import type { RowDataPacket } from "mysql2/promise";
import type { EmailPayload, EmailTemplate, RenderContext } from "../../mail/templates.js";
import { DEFAULT_TIMEZONE } from "../../lib/zoned-time.js";
import { APPOINTMENT_LINK_TTL_MS } from "../auth/one-time-tokens.js";
import { findPatientNameForNotice } from "../patients/patient-repository.js";

export function appointmentIdOf(payload: EmailPayload): number {
  const id = Number(payload.appointmentId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("Plantilla sin appointmentId válido.");
  return id;
}

export interface AppointmentFacts {
  doctorName: string;
  /** Correo de la cuenta del médico: el `Reply-To` de los correos del consultorio al paciente. */
  doctorEmail: string;
  address: string | null;
  createdByRole: string;
  officePhone: string | null;
  /** Horas antes de la cita hasta las que el paciente puede cancelar. */
  cancelNoticeHours: number;
  patientName: string;
  startUtc: Date;
  timezone: string;
}

export async function loadFacts(context: Pick<RenderContext, "payload" | "db">): Promise<AppointmentFacts> {
  const [rows] = await context.db.execute<RowDataPacket[]>(
    `SELECT d.full_name AS doctor_name, du.email AS doctor_email, ds.address, a.created_by_role, d.office_phone,
            a.patient_id, a.start_utc, COALESCE(cs.timezone, ?) AS timezone,
            COALESCE(cs.cancel_notice_hours, 24) AS cancel_notice_hours
       FROM appointment a
       JOIN doctor d ON d.id = a.doctor_id
       JOIN \`user\` du ON du.id = d.user_id
       LEFT JOIN doctor_site ds ON ds.doctor_id = a.doctor_id
       LEFT JOIN calendar_settings cs ON cs.doctor_id = a.doctor_id
      WHERE a.id = ?`,
    [DEFAULT_TIMEZONE, appointmentIdOf(context.payload)],
  );
  const row = rows[0];
  if (!row) throw Object.assign(new Error("La cita del correo ya no existe."), { code: "APPOINTMENT_MISSING" });
  return {
    doctorName: String(row.doctor_name),
    doctorEmail: String(row.doctor_email),
    address: row.address === null || row.address === undefined ? null : String(row.address),
    createdByRole: String(row.created_by_role),
    // Se valida al registrarse (10 dígitos); aquí se vuelve a exigir por si un dato llegara por otra vía.
    officePhone: row.office_phone !== null && /^\d{10}$/.test(String(row.office_phone)) ? String(row.office_phone) : null,
    cancelNoticeHours: Number(row.cancel_notice_hours),
    patientName: (await findPatientNameForNotice(context.db, Number(row.patient_id))) ?? "la persona agendada",
    startUtc: row.start_utc as Date,
    timezone: String(row.timezone),
  };
}

export function whenText(facts: Pick<AppointmentFacts, "startUtc" | "timezone">): string {
  const date = new Intl.DateTimeFormat("es-MX", { timeZone: facts.timezone, dateStyle: "full" }).format(facts.startUtc);
  const time = new Intl.DateTimeFormat("es-MX", { timeZone: facts.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(facts.startUtc);
  return `${date}, ${time} (hora del consultorio)`;
}

export function contactLine(facts: Pick<AppointmentFacts, "officePhone">): string {
  return facts.officePhone ? `Para dudas, llama al consultorio: ${facts.officePhone}.` : "Para dudas, comunícate con el consultorio.";
}

/**
 * Correos de la agenda (ver `contracts/email-notifications.md`). Asuntos sin datos personales y sin datos clínicos; el
 * outbox solo guarda el id de la cita. Los del consultorio al paciente llevan al médico como `Reply-To`.
 */
export const calendarTemplates: Record<string, EmailTemplate> = {
  appointment_created: {
    // Enlace para ver o cancelar la cita: abrirlo nunca cambia el estado (propósito `appointment_confirmation`).
    token: {
      purpose: "appointment_confirmation",
      ttlMs: APPOINTMENT_LINK_TTL_MS,
      linkPath: (token) => `/citas/enlace/${token}`,
      subject: (payload) => ({ appointmentId: appointmentIdOf(payload) }),
    },
    // Si la cita ya se canceló mientras el correo esperaba en cola, no se envía «agendada» después de «cancelada».
    // FOR UPDATE: serializa con la cancelación de esa cita.
    async shouldSend({ payload, db }) {
      const [rows] = await db.execute<RowDataPacket[]>("SELECT status FROM appointment WHERE id = ? FOR UPDATE", [appointmentIdOf(payload)]);
      return rows[0]?.status === "booked";
    },
    async render(context) {
      const facts = await loadFacts(context);
      const intro =
        facts.createdByRole === "patient"
          ? `Tu cita con ${facts.doctorName} quedó agendada para ${facts.patientName}.`
          : `El consultorio de ${facts.doctorName} agendó una cita para ${facts.patientName}.`;
      return {
        subject: "Tu cita dental fue agendada",
        replyTo: facts.doctorEmail,
        text: [
          intro,
          "",
          `Cuándo: ${whenText(facts)}`,
          `Con: ${facts.doctorName}`,
          ...(facts.address ? [`Dónde: ${facts.address}`] : []),
          "",
          ...(context.link ? [`Para ver o cancelar tu cita, abre este enlace e inicia sesión: ${context.link}`, ""] : []),
          contactLine(facts),
        ].join("\n"),
      };
    },
  },

  appointment_cancelled: {
    async render(context) {
      const facts = await loadFacts(context);
      return {
        subject: "Tu cita dental fue cancelada",
        replyTo: facts.doctorEmail,
        text: [
          `El consultorio de ${facts.doctorName} canceló la cita de ${facts.patientName}.`,
          "",
          `La cita era: ${whenText(facts)}`,
          "",
          contactLine(facts),
        ].join("\n"),
      };
    },
  },
};
