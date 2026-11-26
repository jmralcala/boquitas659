import { html, type SafeHtml } from "../../lib/html.js";
import type { EmergencyContact } from "../../modules/urgent/emergency-contact.js";
import { TRIAGE_CONTENT } from "../../modules/urgent/triage-content.js";
import { checkbox, errorList, form, submitButton } from "./forms.js";
import { formatPhone, sitePage } from "./site.js";

type FieldErrors = Readonly<Record<string, readonly string[]>>;

export interface UrgentFormOptions {
  slug: string;
  doctorName: string;
  csrf: string;
  patients: readonly { id: number; name: string }[];
  selectedPatientId: number | null;
  /** Falta la autorización de datos: se muestra la casilla (sin marcar). */
  needsAuthorization: boolean;
  /** Clave pública de Turnstile; `null` en desarrollo sin claves (el widget se omite). */
  siteKey: string | null;
  errors: FieldErrors;
}

function contactLines(contact: EmergencyContact): SafeHtml {
  const mobile = formatPhone(contact.mobile);
  const office = formatPhone(contact.officePhone);
  return html`${mobile !== "" ? html`<p><strong>Móvil de emergencias del médico:</strong> <a href="tel:${contact.mobile ?? ""}">${mobile}</a></p>` : null}
${office !== "" ? html`<p><strong>Teléfono del consultorio:</strong> <a href="tel:${contact.officePhone ?? ""}">${office}</a></p>` : null}`;
}

/**
 * Formulario de urgencia: señales de alarma (sin marcar), las cinco categorías con su semáforo (sin valor por defecto),
 * para quién es la cita, la autorización de datos y el CAPTCHA. NUNCA muestra horarios ni calendario, y nunca repite una
 * categoría recibida: tras un error el formulario vuelve sin ninguna opción elegida.
 */
export function urgentFormPage(options: UrgentFormOptions): string {
  const { errors } = options;
  const content = html`<h1>${options.doctorName}</h1>
<h2>Tengo una urgencia</h2>
<p>Responde estas preguntas y te asignaremos el espacio más próximo con el consultorio. No tendrás que elegir fecha ni hora.</p>
<p><small>Contenido provisional (versión ${TRIAGE_CONTENT.version}); no sustituye la valoración de un profesional.</small></p>
${errorList(errors._)}
${form({
  action: `/c/${options.slug}/urgencia`,
  csrf: options.csrf,
  children: [
    html`<fieldset><legend>¿Tienes alguna de estas señales?</legend>
${TRIAGE_CONTENT.alarmSignals.map((signal) => html`<label><input type="checkbox" name="senales" value="${signal.id}"> ${signal.label}</label>`)}
${errorList(errors.senales)}</fieldset>`,
    html`<fieldset><legend>¿Qué describe mejor lo que sientes?</legend>
${TRIAGE_CONTENT.categories.map(
  (category) => html`<label class="triage triage--${category.tone}"><input type="radio" name="categoria" value="${category.id}" required> <strong>${category.label}.</strong> ${category.optionText}</label>`,
)}
${errorList(errors.categoria)}</fieldset>`,
    html`<label>¿Para quién es la cita?
  <select name="patientId" required>
    ${options.patients.map((patient) => html`<option value="${patient.id}"${options.selectedPatientId === patient.id ? html` selected` : null}>${patient.name}</option>`)}
  </select></label>${errorList(errors.patientId)}`,
    options.needsAuthorization
      ? checkbox({
          name: "autorizo",
          label: html`Autorizo que ${options.doctorName} vea el nombre y los datos de contacto (correo y teléfono) de los pacientes de mi cuenta para atender mi cita, conforme al <a href="/legal/patient_privacy" target="_blank" rel="noopener">aviso de privacidad</a>. Puedo revocarlo cuando quiera.`,
          errors: errors.autorizo,
        })
      : null,
    // El script de Turnstile lo cambia el proveedor de forma continua: no admite integridad de subrecurso (SRI). Riesgo aceptado y documentado (decisión 0005).
    options.siteKey ? html`<div class="cf-turnstile" data-sitekey="${options.siteKey}"></div><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>` : null,
    errorList(errors.captcha),
    submitButton("Pedir cita de urgencia"),
  ],
})}
<p><a href="/c/${options.slug}/reservar">Prefiero una cita normal</a></p>`;
  return sitePage({ title: options.doctorName, content });
}

/** Resultado cuando no hay espacio: cómo comunicarse con el médico y, en los niveles altos, el aviso de hospital. */
export function noSpacePage(options: { doctorName: string; contact: EmergencyContact; hospitalNotice: boolean }): string {
  return sitePage({
    title: options.doctorName,
    content: html`<h1>No encontramos espacio</h1>
<p>No hay un espacio libre en <strong>${options.doctorName}</strong> dentro del tiempo que necesitas. No se agendó ninguna cita.</p>
${options.hospitalNotice ? html`<p role="alert"><strong>${TRIAGE_CONTENT.hospitalNotice}</strong></p>` : null}
<p>Comunícate directamente:</p>
${contactLines(options.contact)}
<h2>Mientras tanto</h2>
<ul>${TRIAGE_CONTENT.firstAid.map((line) => html`<li>${line}</li>`)}</ul>`,
  });
}

/** Pantalla cuando el paciente marcó una señal de alarma: solo el aviso de emergencia y cómo llamar. */
export function alarmPage(options: { doctorName: string; contact: EmergencyContact }): string {
  return sitePage({
    title: options.doctorName,
    content: html`<h1>Busca atención de inmediato</h1>
<p role="alert"><strong>${TRIAGE_CONTENT.alarmNotice}</strong></p>
${contactLines(options.contact)}`,
  });
}

/** El CAPTCHA no se pudo verificar: el flujo no se abre «a ciegas»; se muestra cómo llamar al consultorio. */
export function captchaUnavailablePage(options: { slug: string; doctorName: string; contact: EmergencyContact }): string {
  return sitePage({
    title: options.doctorName,
    content: html`<h1>No pudimos verificar tu solicitud</h1>
<p>En este momento no podemos asignar una urgencia en línea. Si es urgente, llama directamente:</p>
${contactLines(options.contact)}
<p><a href="/c/${options.slug}/reservar">Prefiero una cita normal</a></p>`,
  });
}

/** La urgencia en línea no está disponible (contenido médico pendiente de validación o sin CAPTCHA configurado): llamar al consultorio. */
export function callOfficePage(options: { doctorName: string; contact: EmergencyContact }): string {
  const office = formatPhone(options.contact.officePhone);
  return sitePage({
    title: options.doctorName,
    content: html`<h1>${options.doctorName}</h1>
<p>Las urgencias en línea no están disponibles por ahora. Si es urgente, llama directamente al consultorio.</p>
${office !== "" ? html`<p><strong>Teléfono del consultorio:</strong> <a href="tel:${options.contact.officePhone ?? ""}">${office}</a></p>` : null}`,
  });
}

/** El consultorio no acepta reservas en línea (despublicado o médico sin aprobación): solo el teléfono del consultorio. */
export function urgentUnavailablePage(options: { doctorName: string; officePhone: string | null }): string {
  const office = formatPhone(options.officePhone);
  return sitePage({
    title: options.doctorName,
    content: html`<h1>${options.doctorName}</h1>
<p>Este consultorio no está recibiendo reservas en línea. Confirma directamente con el consultorio por teléfono.</p>
${office !== "" ? html`<p><strong>Teléfono del consultorio:</strong> <a href="tel:${options.officePhone ?? ""}">${office}</a></p>` : null}`,
  });
}
