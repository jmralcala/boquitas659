import type { EmailPayload, EmailTemplate } from "../../mail/templates.js";
import { EMAIL_CHANGE_TTL_MS, PASSWORD_RESET_TTL_MS } from "./one-time-tokens.js";

const dateTimeFormat = new Intl.DateTimeFormat("es-MX", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "America/Mexico_City",
});

function userIdOf(payload: EmailPayload): number {
  const id = Number(payload.userId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("Plantilla sin userId válido.");
  return id;
}

/** Correos de seguridad de la cuenta (ver `contracts/email-notifications.md`). Asuntos sin datos personales. */
export const authTemplates: Record<string, EmailTemplate> = {
  password_reset: {
    token: {
      purpose: "password_reset",
      ttlMs: PASSWORD_RESET_TTL_MS,
      linkPath: (token) => `/recuperar/${token}`,
      subject: (payload) => ({ userId: userIdOf(payload) }),
    },
    render: ({ link }) => ({
      subject: "Recupera tu contraseña",
      text: [
        "Recibimos una solicitud para restablecer la contraseña de tu cuenta.",
        "",
        `Abre este enlace para elegir una contraseña nueva: ${link}`,
        "",
        "El enlace caduca en 30 minutos y solo funciona una vez.",
        "Si no lo pediste, ignora este correo: tu contraseña no cambiará.",
      ].join("\n"),
    }),
  },

  password_changed: {
    render: ({ baseUrl }) => ({
      subject: "La contraseña de tu cuenta cambió",
      text: [
        "La contraseña de tu cuenta se cambió hace un momento.",
        "",
        `Si no fuiste tú, recupera tu acceso de inmediato: ${new URL("/recuperar", baseUrl).toString()}`,
        "y escribe a soporte.",
      ].join("\n"),
    }),
  },

  new_device_login: {
    render: ({ payload, baseUrl }) => {
      const at = typeof payload.at === "string" ? new Date(payload.at) : null;
      const when = at && !Number.isNaN(at.getTime()) ? dateTimeFormat.format(at) : "hace un momento";
      return {
        subject: "Nuevo inicio de sesión en tu cuenta",
        text: [
          `Detectamos un inicio de sesión desde un dispositivo nuevo (${when}).`,
          "",
          "Si fuiste tú, no necesitas hacer nada.",
          `Si no, cambia tu contraseña ahora: ${new URL("/cuenta/contrasena", baseUrl).toString()}`,
        ].join("\n"),
      };
    },
  },

  // Al correo NUEVO: el enlace lo confirma. Mientras tanto el correo de acceso no cambia.
  email_change_confirm: {
    token: {
      purpose: "email_change",
      ttlMs: EMAIL_CHANGE_TTL_MS,
      linkPath: (token) => `/cuenta/correo/confirmar/${token}`,
      subject: (payload) => ({ userId: userIdOf(payload) }),
    },
    render: ({ link }) => ({
      subject: "Confirma tu correo nuevo",
      text: [
        "Pediste usar este correo como el de tu cuenta.",
        "",
        `Para confirmarlo abre este enlace: ${link}`,
        "",
        "El enlace caduca en 60 minutos y solo funciona una vez.",
        "Si no lo pediste, ignora este correo: nada cambiará.",
      ].join("\n"),
    }),
  },

  // Al correo ACTUAL: aviso de que alguien pidió el cambio (todavía no se aplicó).
  email_change_requested: {
    render: ({ baseUrl }) => ({
      subject: "Se pidió cambiar el correo de tu cuenta",
      text: [
        "Se pidió cambiar el correo de tu cuenta a otra dirección. El cambio solo se aplica si esa dirección lo confirma.",
        "",
        "Si fuiste tú, no necesitas hacer nada más.",
        `Si no fuiste tú, cambia tu contraseña ahora: ${new URL("/cuenta/contrasena", baseUrl).toString()}`,
        "y escribe a soporte.",
      ].join("\n"),
    }),
  },

  email_changed_old: {
    render: () => ({
      subject: "El correo de tu cuenta cambió",
      text: [
        "El correo de tu cuenta se cambió a otra dirección.",
        "",
        "Si no fuiste tú, escribe a soporte de inmediato para recuperar tu cuenta.",
      ].join("\n"),
    }),
  },

  email_changed_new: {
    render: () => ({
      subject: "Confirmamos el cambio de correo de tu cuenta",
      text: "Este correo es ahora el de tu cuenta. Las notificaciones de seguridad llegarán aquí.",
    }),
  },

  emergency_mobile_changed: {
    render: ({ baseUrl }) => ({
      subject: "El móvil de emergencias de tu cuenta cambió",
      text: [
        "El móvil de emergencias de tu cuenta se cambió hace un momento.",
        "",
        `Si no fuiste tú, cambia tu contraseña ahora: ${new URL("/cuenta/contrasena", baseUrl).toString()}`,
        "y escribe a soporte.",
      ].join("\n"),
    }),
  },
};
