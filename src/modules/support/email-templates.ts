import type { EmailTemplate } from "../../mail/templates.js";

/**
 * Avisos al médico por los cambios de soporte (ver `contracts/email-notifications.md`). Los textos son fijos y
 * provisionales hasta la revisión legal, y NUNCA incluyen el motivo interno que escribió soporte.
 */
export const supportTemplates: Record<string, EmailTemplate> = {
  doctor_account_suspended: {
    render: () => ({
      subject: "Tu cuenta fue suspendida",
      text: [
        "Tu cuenta fue suspendida: tu acceso y las reservas en línea de tu consultorio están pausados.",
        "",
        "Las citas que ya estaban agendadas se conservan.",
        "Si crees que es un error, responde a este correo o escribe a soporte.",
      ].join("\n"),
    }),
  },

  doctor_account_read_only: {
    render: ({ baseUrl }) => ({
      subject: "Tu cuenta está en solo lectura",
      text: [
        "Tu cuenta quedó en solo lectura: puedes consultar tu agenda, pero no modificarla, y tu micrositio no acepta reservas nuevas.",
        "",
        "Las citas ya agendadas se conservan y tus pacientes pueden cancelarlas.",
        "",
        `Consulta tu agenda: ${new URL("/agenda", baseUrl).toString()}`,
      ].join("\n"),
    }),
  },

  doctor_account_reactivated: {
    render: ({ baseUrl }) => ({
      subject: "Tu cuenta fue reactivada",
      text: [
        "Tu cuenta fue reactivada: ya puedes usar tu agenda y tu micrositio como antes.",
        "",
        `Entra a tu panel: ${new URL("/medicos/panel", baseUrl).toString()}`,
      ].join("\n"),
    }),
  },

  doctor_site_slug_changed: {
    render: ({ payload, baseUrl }) => {
      const slug = String(payload.slug ?? "");
      if (!/^[a-z0-9-]{3,40}$/.test(slug)) throw new Error("Plantilla sin enlace válido.");
      return {
        subject: "Cambió el enlace de tu micrositio",
        text: [
          "Soporte cambió el enlace de tu micrositio.",
          "",
          `Tu enlace nuevo es: ${new URL(`/c/${slug}`, baseUrl).toString()}`,
          "El enlace anterior dejó de funcionar: compártelo de nuevo con tus pacientes.",
        ].join("\n"),
      };
    },
  },
};
