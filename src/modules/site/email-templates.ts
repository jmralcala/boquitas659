import type { RowDataPacket } from "mysql2/promise";
import type { EmailTemplate } from "../../mail/templates.js";
import { formatLocalInstant } from "../../lib/zoned-time.js";
import { APPOINTMENT_LINK_TTL_MS } from "../auth/one-time-tokens.js";
import { appointmentIdOf, contactLine, loadFacts, whenText } from "../calendar/email-templates.js";

/**
 * Correos del micrositio y las citas del paciente (ver `contracts/email-notifications.md`). Los avisos al médico van al
 * correo de su cuenta (no a recepción) y solo llevan el nombre del paciente, nunca su teléfono ni su correo.
 */
export const siteTemplates: Record<string, EmailTemplate> = {
  // Recordatorio (lo encola el job de recordatorios): sale mientras el paciente todavía puede cancelar.
  appointment_reminder: {
    token: {
      purpose: "appointment_reminder",
      ttlMs: APPOINTMENT_LINK_TTL_MS,
      linkPath: (token) => `/citas/enlace/${token}`,
      subject: (payload) => ({ appointmentId: appointmentIdOf(payload) }),
    },
    // FOR UPDATE: serializa con la cancelación; una cita cancelada o ya iniciada no se recuerda.
    async shouldSend({ payload, db, now }) {
      const [rows] = await db.execute<RowDataPacket[]>("SELECT status, start_utc FROM appointment WHERE id = ? FOR UPDATE", [appointmentIdOf(payload)]);
      return rows[0]?.status === "booked" && (rows[0].start_utc as Date).getTime() > now.getTime();
    },
    async render(context) {
      const facts = await loadFacts(context);
      const deadline = new Date(facts.startUtc.getTime() - facts.cancelNoticeHours * 3_600_000);
      return {
        subject: "Recordatorio de tu cita dental",
        replyTo: facts.doctorEmail,
        text: [
          `Te recordamos la cita de ${facts.patientName} con ${facts.doctorName}.`,
          "",
          `Cuándo: ${whenText(facts)}`,
          ...(facts.address ? [`Dónde: ${facts.address}`] : []),
          "",
          `Puedes cancelar hasta: ${whenText({ startUtc: deadline, timezone: facts.timezone })}`,
          ...(context.link ? [`Para ver o cancelar tu cita, abre este enlace e inicia sesión: ${context.link}`] : []),
          "",
          contactLine(facts),
        ].join("\n"),
      };
    },
  },

  // El personal vinculó a la cuenta al agendarle una cita: se informa qué ve el consultorio y cómo revocar.
  patient_linked_by_office: {
    async render(context) {
      const facts = await loadFacts(context);
      return {
        subject: "Un consultorio agendó una cita para ti",
        replyTo: facts.doctorEmail,
        text: [
          `El consultorio de ${facts.doctorName} agendó una cita para ${facts.patientName}.`,
          "",
          `Cuándo: ${whenText(facts)}`,
          "",
          "A partir de ahora el consultorio puede ver el nombre y los datos de contacto (correo y teléfono) de los pacientes de tu cuenta para atender tus citas.",
          `Si no quieres compartir tus datos con este consultorio, puedes revocar el vínculo en: ${new URL("/pacientes/consultorios", context.baseUrl).toString()}`,
          "Al revocar se cancelan tus citas futuras con ese consultorio.",
        ].join("\n"),
      };
    },
  },

  doctor_appointment_booked: {
    async render(context) {
      const facts = await loadFacts(context);
      const date = formatLocalInstant(facts.timezone, facts.startUtc).slice(0, 10);
      return {
        subject: "Nueva cita agendada",
        text: [
          `Un paciente agendó una cita en tu consultorio: ${facts.patientName}.`,
          "",
          `Cuándo: ${whenText(facts)}`,
          "Tipo: convencional",
          "",
          `Ver la agenda: ${new URL(`/agenda/dia/${date}`, context.baseUrl).toString()}`,
        ].join("\n"),
      };
    },
  },

  // Constancia para el paciente que canceló (o cuya cuenta retiró el vínculo con el consultorio).
  appointment_cancelled_by_patient: {
    async render(context) {
      const facts = await loadFacts(context);
      return {
        subject: "Cancelaste tu cita dental",
        replyTo: facts.doctorEmail,
        text: [
          `Cancelaste la cita de ${facts.patientName} con ${facts.doctorName}.`,
          "",
          `La cita era: ${whenText(facts)}`,
          "",
          contactLine(facts),
        ].join("\n"),
      };
    },
  },

  // Aviso al correo del médico (no a recepción): solo el nombre del paciente, nunca su teléfono ni su correo.
  doctor_appointment_cancelled: {
    async render(context) {
      const facts = await loadFacts(context);
      const date = formatLocalInstant(facts.timezone, facts.startUtc).slice(0, 10);
      const revoked = context.payload.reason === "revoked";
      return {
        subject: "Cita cancelada por el paciente",
        text: [
          `El paciente ${facts.patientName} canceló su cita.`,
          ...(revoked ? ["Motivo: el paciente retiró su vínculo con el consultorio."] : []),
          "",
          `La cita era: ${whenText(facts)}`,
          "",
          `Ver la agenda: ${new URL(`/agenda/dia/${date}`, context.baseUrl).toString()}`,
        ].join("\n"),
      };
    },
  },
};
