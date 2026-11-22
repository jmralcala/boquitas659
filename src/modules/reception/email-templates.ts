import type { RowDataPacket } from "mysql2/promise";
import type { EmailPayload, EmailTemplate } from "../../mail/templates.js";
import { INVITATION_TTL_MS } from "../auth/one-time-tokens.js";

function idOf(payload: EmailPayload, key: string): number {
  const id = Number(payload[key]);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`Plantilla sin ${key} válido.`);
  return id;
}

/** Correos de recepción (ver `contracts/email-notifications.md`). Asuntos sin datos personales. */
export const receptionTemplates: Record<string, EmailTemplate> = {
  reception_invitation: {
    token: {
      purpose: "reception_invite",
      ttlMs: INVITATION_TTL_MS,
      linkPath: (token) => `/recepcion/invitacion/${token}`,
      subject: (payload) => ({ invitationId: idOf(payload, "invitationId") }),
    },
    // Si la invitación se revocó, venció o ya se aceptó mientras el correo esperaba en cola, no se envía.
    async shouldSend({ payload, db, now }) {
      const [rows] = await db.execute<RowDataPacket[]>("SELECT status, expires_at FROM reception_invitation WHERE id = ?", [idOf(payload, "invitationId")]);
      const row = rows[0];
      return row !== undefined && row.status === "pending" && (row.expires_at as Date).getTime() > now.getTime();
    },
    async render({ payload, link, db }) {
      const [rows] = await db.execute<RowDataPacket[]>(
        "SELECT d.full_name FROM reception_invitation i JOIN doctor d ON d.id = i.doctor_id WHERE i.id = ?",
        [idOf(payload, "invitationId")],
      );
      const doctorName = rows[0] ? String(rows[0].full_name) : "Un médico";
      return {
        subject: "Te invitaron a colaborar en una agenda dental",
        text: [
          `${doctorName} te invitó a colaborar como personal de recepción en su agenda.`,
          "",
          `Abre este enlace para aceptar la invitación: ${link}`,
          "",
          `La invitación caduca en ${Math.round(INVITATION_TTL_MS / 86_400_000)} días y el enlace solo funciona una vez.`,
          "Si no esperabas este correo, ignóralo.",
        ].join("\n"),
      };
    },
  },

  reception_joined: {
    async render({ payload, db, baseUrl }) {
      const [rows] = await db.execute<RowDataPacket[]>(
        "SELECT email_normalized FROM reception_invitation WHERE id = ?",
        [idOf(payload, "invitationId")],
      );
      const email = rows[0] ? String(rows[0].email_normalized) : "una persona";
      return {
        subject: "Una persona aceptó tu invitación de recepción",
        text: [
          `${email} aceptó tu invitación y ya tiene acceso a tu agenda como personal de recepción.`,
          "",
          `Puedes administrar a tu equipo aquí: ${new URL("/medicos/recepcion", baseUrl).toString()}`,
        ].join("\n"),
      };
    },
  },

  reception_removed: {
    async render({ payload, db }) {
      const [rows] = await db.execute<RowDataPacket[]>("SELECT full_name FROM doctor WHERE id = ?", [idOf(payload, "doctorId")]);
      const doctorName = rows[0] ? String(rows[0].full_name) : "un médico";
      return {
        subject: "Ya no tienes acceso a una agenda",
        text: `${doctorName} retiró tu acceso como personal de recepción. Ya no puedes ver su agenda ni los datos de sus pacientes.`,
      };
    },
  },
};
