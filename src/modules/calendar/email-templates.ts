import type { RowDataPacket } from "mysql2/promise";
import type { EmailPayload, EmailTemplate, RenderContext } from "../../mail/templates.js";
import { DEFAULT_TIMEZONE } from "../../lib/zoned-time.js";
import { findPatientNameForNotice } from "../patients/patient-repository.js";

function appointmentIdOf(payload: EmailPayload): number {
  const id = Number(payload.appointmentId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("Plantilla sin appointmentId válido.");
  return id;
}

interface AppointmentFacts {
  doctorName: string;
  officePhone: string | null;
  patientName: string;
  startUtc: Date;
  timezone: string;
}

async function loadFacts(context: Pick<RenderContext, "payload" | "db">): Promise<AppointmentFacts> {
  const [rows] = await context.db.execute<RowDataPacket[]>(
    `SELECT d.full_name AS doctor_name, d.office_phone, a.patient_id, a.start_utc,
            COALESCE(cs.timezone, ?) AS timezone
       FROM appointment a
       JOIN doctor d ON d.id = a.doctor_id
       LEFT JOIN calendar_settings cs ON cs.doctor_id = a.doctor_id
      WHERE a.id = ?`,
    [DEFAULT_TIMEZONE, appointmentIdOf(context.payload)],
  );
  const row = rows[0];
  if (!row) throw Object.assign(new Error("La cita del correo ya no existe."), { code: "APPOINTMENT_MISSING" });
  return {
    doctorName: String(row.doctor_name),
    // Se valida al registrarse (10 dígitos); aquí se vuelve a exigir por si un dato llegara por otra vía.
    officePhone: row.office_phone !== null && /^\d{10}$/.test(String(row.office_phone)) ? String(row.office_phone) : null,
    patientName: (await findPatientNameForNotice(context.db, Number(row.patient_id))) ?? "la persona agendada",
    startUtc: row.start_utc as Date,
    timezone: String(row.timezone),
  };
}

function whenText(facts: AppointmentFacts): string {
  const date = new Intl.DateTimeFormat("es-MX", { timeZone: facts.timezone, dateStyle: "full" }).format(facts.startUtc);
  const time = new Intl.DateTimeFormat("es-MX", { timeZone: facts.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(facts.startUtc);
  return `${date}, ${time} (hora del consultorio)`;
}

function contactLine(facts: AppointmentFacts): string {
  return facts.officePhone ? `Para dudas, llama al consultorio: ${facts.officePhone}.` : "Para dudas, comunícate con el consultorio.";
}

/**
 * Correos de la agenda (ver `contracts/email-notifications.md`). Asuntos sin datos personales, sin enlaces de acción y
 * sin datos clínicos; el outbox solo guarda el id de la cita.
 */
export const calendarTemplates: Record<string, EmailTemplate> = {
  appointment_created: {
    // Si la cita ya se canceló mientras el correo esperaba en cola, no se envía «agendada» después de «cancelada».
    // FOR UPDATE: serializa con la cancelación de esa cita.
    async shouldSend({ payload, db }) {
      const [rows] = await db.execute<RowDataPacket[]>("SELECT status FROM appointment WHERE id = ? FOR UPDATE", [appointmentIdOf(payload)]);
      return rows[0]?.status === "booked";
    },
    async render(context) {
      const facts = await loadFacts(context);
      return {
        subject: "Tu cita dental fue agendada",
        text: [
          `El consultorio de ${facts.doctorName} agendó una cita para ${facts.patientName}.`,
          "",
          `Cuándo: ${whenText(facts)}`,
          `Con: ${facts.doctorName}`,
          "",
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
