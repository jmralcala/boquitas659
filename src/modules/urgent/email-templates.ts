import type { RowDataPacket } from "mysql2/promise";
import { formatLocalInstant } from "../../lib/zoned-time.js";
import type { EmailTemplate } from "../../mail/templates.js";
import { appointmentIdOf, loadFacts, whenText } from "../calendar/email-templates.js";
import { categoryById, parseCategory } from "./triage-content.js";

/**
 * Correos de las urgencias (ver `contracts/email-notifications.md`). El aviso al médico va al correo de su cuenta (no a
 * recepción) y lleva la categoría del semáforo, el día y la hora, pero NUNCA el nombre del paciente ni datos de contacto.
 * La categoría es la única clave sensible del outbox: se elimina al enviarse, cancelarse, abandonarse o a las 24 horas.
 */
export const urgentTemplates: Record<string, EmailTemplate> = {
  doctor_urgent_notice: {
    sensitiveKeys: ["category"],
    // Si el envío se abandona, el médico recibe el aviso genérico (sin categoría).
    fallbackTemplate: "doctor_urgent_generic",
    // FOR UPDATE: serializa con la cancelación; una urgencia cancelada o ya iniciada no se avisa.
    async shouldSend({ payload, db, now }) {
      const [rows] = await db.execute<RowDataPacket[]>("SELECT status, start_utc FROM appointment WHERE id = ? FOR UPDATE", [appointmentIdOf(payload)]);
      return rows[0]?.status === "booked" && (rows[0].start_utc as Date).getTime() > now.getTime();
    },
    async render(context) {
      const facts = await loadFacts(context);
      const parsed = parseCategory(context.payload.category);
      const date = formatLocalInstant(facts.timezone, facts.startUtc).slice(0, 10);
      return {
        subject: "Nueva urgencia agendada",
        text: [
          "Un paciente agendó una urgencia en tu consultorio.",
          "",
          ...(parsed ? [`Categoría: ${categoryById(parsed).label}`] : []),
          `Cuándo: ${whenText(facts)}`,
          "",
          `Ver la agenda: ${new URL(`/agenda/dia/${date}`, context.baseUrl).toString()}`,
        ].join("\n"),
      };
    },
  },

  // Aviso genérico: sin categoría, sin nombre y sin hora; solo remite a la agenda.
  doctor_urgent_generic: {
    render(context) {
      return {
        subject: "Tienes una urgencia agendada",
        text: ["Tienes una urgencia agendada en tu consultorio.", "", `Revisa tu agenda: ${new URL("/agenda", context.baseUrl).toString()}`].join("\n"),
      };
    },
  },
};
