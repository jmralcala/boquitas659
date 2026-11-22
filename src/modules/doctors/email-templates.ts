import type { RowDataPacket } from "mysql2/promise";
import type { EmailTemplate } from "../../mail/templates.js";

const dateFormat = new Intl.DateTimeFormat("es-MX", { dateStyle: "long", timeZone: "America/Mexico_City" });

function doctorIdOf(payload: Readonly<Record<string, string | number | null>>): number {
  const id = Number(payload.doctorId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("Plantilla sin doctorId válido.");
  return id;
}

/** Correos del flujo de aprobación de médicos (ver `contracts/email-notifications.md`). */
export const doctorTemplates: Record<string, EmailTemplate> = {
  // Aviso a soporte: sin datos de la cédula ni del médico, sin adjuntos, con enlace al panel.
  support_new_doctor: {
    render: ({ payload, baseUrl }) => ({
      subject: "Nueva solicitud de médico pendiente de revisión",
      text: [
        "Hay una solicitud de médico pendiente de revisión.",
        "",
        `Revísala en el panel de soporte: ${new URL(`/soporte/medicos/${doctorIdOf(payload)}`, baseUrl).toString()}`,
        "",
        "Este aviso no incluye datos del médico ni archivos adjuntos.",
      ].join("\n"),
    }),
  },

  doctor_approved: {
    async render({ payload, baseUrl, db }) {
      const [rows] = await db.execute<RowDataPacket[]>("SELECT trial_ends_at FROM doctor WHERE id = ?", [
        doctorIdOf(payload),
      ]);
      const ends = rows[0]?.trial_ends_at as Date | undefined;
      return {
        subject: "Tu cuenta fue aprobada",
        text: [
          "Tu cuenta fue aprobada y ya puedes iniciar sesión.",
          ends ? `Tu prueba de 5 días termina el ${dateFormat.format(ends)}.` : "Tu prueba de 5 días ya comenzó.",
          "",
          `Inicia sesión: ${new URL("/login", baseUrl).toString()}`,
        ].join("\n"),
      };
    },
  },

  doctor_rejected: {
    async render({ payload, baseUrl, db }) {
      const [rows] = await db.execute<RowDataPacket[]>("SELECT rejection_reason FROM doctor WHERE id = ?", [
        doctorIdOf(payload),
      ]);
      const reason = rows[0]?.rejection_reason ? String(rows[0].rejection_reason) : "Sin motivo indicado.";
      return {
        subject: "Tu solicitud necesita correcciones",
        text: [
          "No pudimos aprobar tu solicitud todavía.",
          "",
          `Motivo: ${reason}`,
          "",
          `Corrige tus datos y vuelve a enviarla: ${new URL("/medicos/estado", baseUrl).toString()}`,
        ].join("\n"),
      };
    },
  },
};
