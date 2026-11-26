import { html, type SafeHtml } from "../../lib/html.js";
import { formatDate, formatTime, calendarLayout } from "./calendar.js";
import type { AppointmentSummary } from "../../modules/site/appointment-links.js";
import type { OfficeItem } from "../../modules/site/offices-service.js";
import type { PatientAppointmentItem, PatientAppointmentList } from "../../modules/site/patient-appointments.js";
import type { DayView, MonthView } from "../../modules/site/availability-view.js";
import { weekdayOfLocalDate } from "../../lib/zoned-time.js";
import { checkbox, csrfInput, errorList, form, passwordInput, submitButton, textInput } from "./forms.js";
import { page } from "./layout.js";

export { formatDate, formatDateTime, formatTime } from "./calendar.js";

/**
 * Página del micrositio y de las pantallas del paciente. El diseño base ya lleva `noindex`, el pie con el aviso de
 * privacidad y el canal de derechos; aquí se añade solo lo común del micrositio.
 */
export function sitePage(options: { title: string; content: SafeHtml }): string {
  return page({ title: options.title, content: options.content });
}

/** Teléfono de 10 dígitos para mostrar (`55 9876 5432`); cadena vacía si no hay un número válido. */
export function formatPhone(phone: string | null): string {
  if (phone === null || !/^\d{10}$/.test(phone)) return "";
  return `${phone.slice(0, 2)} ${phone.slice(2, 6)} ${phone.slice(6)}`;
}

/** Párrafo con el teléfono del consultorio para confirmar directamente (o nada si no hay uno válido). */
export function phoneNotice(phone: string | null): SafeHtml | null {
  const label = formatPhone(phone);
  if (label === "") return null;
  return html`<p>Teléfono del consultorio: <a href="tel:${phone ?? ""}">${label}</a></p>`;
}

// --- Micrositio público ------------------------------------------------------------------------------------------------

export interface PublicSiteView {
  slug: string;
  doctorName: string;
  address: string | null;
  officePhone: string | null;
  hasLogo: boolean;
}

/** Enlace «Cómo llegar»: abre la dirección en Google Maps. No usa clave ni incrusta nada de terceros en la página. */
export function directionsUrl(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

/** Micrositio de un consultorio que acepta reservas: datos públicos y las dos puertas de entrada del paciente. */
export function publicSitePage(site: PublicSiteView): string {
  const base = `/c/${site.slug}`;
  const content = html`<h1>${site.doctorName}</h1>
${site.hasLogo ? html`<p><img src="${base}/logo" alt="Logo de ${site.doctorName}" width="160"></p>` : null}
${site.address ? html`<p><strong>Dirección:</strong> ${site.address}</p>` : null}
${site.address ? html`<p><a href="${directionsUrl(site.address)}" target="_blank" rel="noopener noreferrer">Cómo llegar</a></p>` : null}
${phoneNotice(site.officePhone)}
<h2>Agenda tu cita</h2>
<ul>
  <li><a href="${base}/primera-cita">Primera cita</a>: crea tu cuenta y reserva.</li>
  <li><a href="${base}/entrar">Ya soy paciente</a>: inicia sesión y reserva.</li>
</ul>`;
  return sitePage({ title: site.doctorName, content });
}

/** Aviso cuando el consultorio no recibe reservas en línea (despublicado, o el médico ya no está aprobado). */
export function unavailableSitePage(options: { doctorName: string; officePhone: string | null }): string {
  const content = html`<h1>${options.doctorName}</h1>
<p>Este consultorio no está recibiendo reservas en línea por ahora. Confirma tu cita directamente con el consultorio por teléfono.</p>
${phoneNotice(options.officePhone)}`;
  return sitePage({ title: options.doctorName, content });
}

// --- «Mi micrositio» (médico) ---------------------------------------------------------------------------------------------

export interface DoctorSiteView {
  site: { slug: string; address: string | null; status: "draft" | "published" | "unpublished"; hasLogo: boolean; url: string } | null;
  missing: readonly string[];
}

const STATUS_LABEL: Readonly<Record<string, string>> = { draft: "Borrador (todavía no publicado)", published: "Publicado", unpublished: "Despublicado" };

/** Pantalla del médico para administrar su micrositio. Repinta lo escrito si hubo errores. */
export function doctorSitePage(options: {
  csrf: string;
  view: DoctorSiteView;
  values?: Record<string, string>;
  errors?: Readonly<Record<string, readonly string[]>>;
  canConfigure?: boolean;
}): string {
  const { site, missing } = options.view;
  const errors = options.errors ?? {};
  const values = options.values ?? {};
  const nameSection = site
    ? html`<p>Tu enlace: <a href="${site.url}">${site.url}</a></p><p><small>El nombre del enlace no se puede cambiar; si necesitas otro, contacta a soporte.</small></p>`
    : html`<form method="post" action="/medicos/micrositio/nombre">
${csrfInput(options.csrf)}
<p><label>Nombre de tu enlace (3 a 40 caracteres: minúsculas, números y guiones)
  <input type="text" name="slug" value="${values.slug ?? ""}" required maxlength="40" pattern="[a-z0-9]+(-[a-z0-9]+)*"></label></p>
${errorList(errors.slug)}
<p><small>Se elige una sola vez y el primero que lo registra se queda con él.</small></p>
<button type="submit">Reservar nombre</button>
</form>`;
  const addressSection = site
    ? html`<form method="post" action="/medicos/micrositio">
${csrfInput(options.csrf)}
<p><label>Dirección del consultorio <input type="text" name="address" value="${values.address ?? site.address ?? ""}" required maxlength="300" size="60"></label></p>
${errorList(errors.address)}
<button type="submit">Guardar dirección</button>
</form>`
    : html`<p>Primero elige el nombre de tu enlace.</p>`;
  const logoSection = site
    ? html`<form method="post" action="/medicos/micrositio/logo" enctype="multipart/form-data">
${csrfInput(options.csrf)}
<p><label>Logo (PNG, JPEG o WebP de hasta 1 MB, opcional) <input type="file" name="logo" accept="image/png,image/jpeg,image/webp"></label></p>
${errorList(errors.logo)}
<button type="submit">Subir logo</button>
</form>
${site.hasLogo ? html`<form method="post" action="/medicos/micrositio/logo/quitar">${csrfInput(options.csrf)}<button type="submit">Quitar logo</button></form>` : null}`
    : null;
  const publishSection = html`<p>Estado: <strong>${site ? (STATUS_LABEL[site.status] ?? site.status) : "Sin nombre de enlace"}</strong></p>
${missing.length > 0 ? html`<p>Para publicar falta: ${missing.join(", ")}.</p>` : null}
${site?.status === "published"
    ? html`<form method="post" action="/medicos/micrositio/despublicar">${csrfInput(options.csrf)}<button type="submit">Despublicar</button></form>
<p><small>Al despublicar, el enlace deja de aceptar reservas; las citas existentes se conservan.</small></p>`
    : html`<form method="post" action="/medicos/micrositio/publicar">${csrfInput(options.csrf)}<button type="submit"${missing.length > 0 ? html` disabled` : null}>Publicar</button></form>`}`;
  const content = html`<h1>Mi micrositio</h1>
<h2>Enlace</h2>${nameSection}
<h2>Dirección</h2>${addressSection}
${logoSection ? html`<h2>Logo</h2>${logoSection}` : null}
<h2>Publicación</h2>${publishSection}
<p><a href="/agenda/configuracion">Configurar mi calendario (horario, duración y límite de cancelación)</a></p>`;
  return calendarLayout({ title: "Mi micrositio", content, canConfigure: options.canConfigure ?? true });
}

// --- Entrada del paciente (Ya soy paciente / Primera cita) ------------------------------------------------------------

type FieldErrors = Readonly<Record<string, readonly string[]>>;

function hiddenDate(fecha: string | null): SafeHtml | null {
  return fecha === null ? null : html`<input type="hidden" name="fecha" value="${fecha}">`;
}

/** «Ya soy paciente»: correo y contraseña; la recuperación de contraseña es la de la cuenta (feature 1). */
export function entryPage(options: { slug: string; doctorName: string; csrf: string; email: string; fecha: string | null; error?: string }): string {
  const content = html`<h1>${options.doctorName}</h1>
<h2>Ya soy paciente</h2>
${options.error ? errorList([options.error]) : null}
${form({
  action: `/c/${options.slug}/entrar`,
  csrf: options.csrf,
  children: [
    hiddenDate(options.fecha),
    textInput({ name: "email", label: "Correo", type: "email", value: options.email, autocomplete: "username", required: true }),
    passwordInput({ name: "password", label: "Contraseña", autocomplete: "current-password", required: true }),
    submitButton("Entrar"),
  ],
})}
<p><a href="/recuperar">¿Olvidaste tu contraseña?</a></p>
<p><a href="/c/${options.slug}/primera-cita">Es mi primera cita</a></p>`;
  return sitePage({ title: options.doctorName, content });
}

/** «Primera cita»: alta de la cuenta de paciente (casilla de privacidad sin marcar). */
export function firstAppointmentPage(options: {
  slug: string;
  doctorName: string;
  csrf: string;
  values: Readonly<Record<string, string>>;
  errors: FieldErrors;
  fecha: string | null;
  notice?: string;
}): string {
  const { values, errors } = options;
  const content = html`<h1>${options.doctorName}</h1>
<h2>Primera cita</h2>
${options.notice ? html`<p>${options.notice}</p>` : null}
${errorList(errors._)}
${form({
  action: `/c/${options.slug}/primera-cita`,
  csrf: options.csrf,
  children: [
    hiddenDate(options.fecha),
    textInput({ name: "fullName", label: "Nombre completo", value: values.fullName ?? "", autocomplete: "name", required: true, errors: errors.fullName }),
    textInput({ name: "birthDate", label: "Fecha de nacimiento", type: "date", value: values.birthDate ?? "", autocomplete: "bday", required: true, errors: errors.birthDate }),
    textInput({ name: "email", label: "Correo", type: "email", value: values.email ?? "", autocomplete: "username", required: true, errors: errors.email }),
    textInput({ name: "phone", label: "Teléfono (10 dígitos)", type: "tel", value: values.phone ?? "", autocomplete: "tel", required: true, errors: errors.phone }),
    passwordInput({ name: "password", label: "Contraseña (mínimo 10 caracteres)", autocomplete: "new-password", required: true, errors: errors.password }),
    checkbox({
      name: "acceptPrivacy",
      label: html`He leído y acepto el <a href="/legal/patient_privacy" target="_blank" rel="noopener">aviso de privacidad</a> y doy mi consentimiento expreso para el tratamiento de mis datos de salud`,
      errors: errors.acceptPrivacy,
    }),
    submitButton("Crear cuenta y continuar"),
  ],
})}
<p><a href="/c/${options.slug}/entrar">Ya tengo cuenta</a></p>`;
  return sitePage({ title: options.doctorName, content });
}

// --- Reserva del paciente (calendario «tipo aerolínea») ---------------------------------------------------------------------

const monthNameFormatter = new Intl.DateTimeFormat("es-MX", { timeZone: "UTC", month: "long", year: "numeric" });
const WEEKDAY_HEADERS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"] as const;

export interface BookingPatientOption {
  id: number;
  name: string;
}

export interface BookingPageOptions {
  slug: string;
  doctorName: string;
  csrf: string;
  month: MonthView;
  day: DayView | null;
  patients: readonly BookingPatientOption[];
  selectedPatientId: number | null;
  selectedStart: string | null;
  /** Falta la autorización de datos: se muestra la casilla (sin marcar). */
  needsAuthorization: boolean;
  /** La urgencia en línea está disponible (contenido médico validado y CAPTCHA configurado en producción). */
  urgentOffered: boolean;
  /** Hora de entrada a la pantalla de reservar, firmada: viaja en los enlaces y en el formulario (solo para medir el tiempo). */
  track?: string;
  errors: FieldErrors;
  /** Aviso al volver a mostrar la página (por ejemplo, el horario elegido ya no está disponible). */
  notice?: string;
}

function monthCalendar(slug: string, month: MonthView, track?: string): SafeHtml {
  const base = `/c/${slug}/reservar`;
  const trackParam = track ? `&a=${encodeURIComponent(track)}` : "";
  const first = month.days[0];
  const offset = first ? weekdayOfLocalDate(first.date) - 1 : 0;
  const cells: (SafeHtml | null)[] = Array.from({ length: offset }, () => null);
  for (const entry of month.days) {
    const number = Number(entry.date.slice(8));
    cells.push(
      entry.enabled
        ? html`<a href="${base}?fecha=${entry.date}${trackParam}" aria-label="${entry.date}, ${entry.freeCount} horarios libres">${number}</a>`
        : html`<span aria-disabled="true">${number}</span>`,
    );
  }
  const weeks: (SafeHtml | null)[][] = [];
  for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7));
  const label = monthNameFormatter.format(new Date(`${month.month}-01T00:00:00Z`));
  return html`<h2>${label}</h2>
<p>
  ${month.prevMonth ? html`<a href="${base}?mes=${month.prevMonth}${trackParam}">« Mes anterior</a>` : null}
  ${month.nextMonth ? html`<a href="${base}?mes=${month.nextMonth}${trackParam}">Mes siguiente »</a>` : null}
</p>
<table>
  <thead><tr>${WEEKDAY_HEADERS.map((name) => html`<th scope="col">${name}</th>`)}</tr></thead>
  <tbody>${weeks.map((week) => html`<tr>${week.map((cell) => html`<td>${cell}</td>`)}</tr>`)}</tbody>
</table>`;
}

/**
 * Pantalla de reserva: el mes con los días disponibles y, si se eligió un día, sus horarios y el formulario. No usa
 * JavaScript: elegir el día es un enlace y reservar es un formulario.
 */
export function bookingPage(options: BookingPageOptions): string {
  const base = `/c/${options.slug}`;
  const { day, errors } = options;
  const dayContent = day
    ? html`<h2>Horarios del ${day.date}</h2>
${day.slots.length === 0 ? html`<p>No hay horarios disponibles ese día. Elige otro día del calendario.</p>` : null}
${day.slots.length > 0
  ? form({
      action: `${base}/reservar`,
      csrf: options.csrf,
      children: [
        html`<fieldset><legend>Horario (hora del consultorio)</legend>${errorList(errors.inicio)}
${day.slots.map(
  (slot) => html`<label><input type="radio" name="inicio" value="${slot.startLocal}"${options.selectedStart === slot.startLocal ? html` checked` : null} required> ${formatTime(day.timezone, slot.startUtc)}</label>`,
)}</fieldset>`,
        html`${options.track ? html`<input type="hidden" name="abierto" value="${options.track}">` : null}<label>Paciente
  <select name="patientId" required>
    ${options.patients.map((patient) => html`<option value="${patient.id}"${options.selectedPatientId === patient.id ? html` selected` : null}>${patient.name}</option>`)}
  </select></label>${errorList(errors.patientId)}
<p><a href="${base}/paciente-adicional">Añadir un paciente adicional (por ejemplo, un hijo)</a></p>`,
        options.needsAuthorization
          ? checkbox({
              name: "autorizo",
              label: html`Autorizo que ${options.doctorName} vea el nombre y los datos de contacto (correo y teléfono) de los pacientes de mi cuenta para atender mi cita, conforme al <a href="/legal/patient_privacy" target="_blank" rel="noopener">aviso de privacidad</a>. Puedo revocarlo cuando quiera.`,
              errors: errors.autorizo,
            })
          : null,
        submitButton("Reservar cita"),
      ],
    })
  : null}`
    : html`<p>Elige un día del calendario para ver los horarios libres.</p>`;

  const content = html`<h1>${options.doctorName}</h1>
<p>Agenda tu cita: elige un día y un horario.</p>
${options.notice ? html`<p role="alert">${options.notice}</p>` : null}
${errorList(errors._)}
${monthCalendar(options.slug, options.month, options.track)}
${dayContent}
${options.urgentOffered ? html`<p><a href="${base}/urgencia">Tengo una urgencia</a></p>` : null}
<p><a href="/pacientes/citas">Mis citas</a></p>`;
  return sitePage({ title: options.doctorName, content });
}

/** Alta de un paciente adicional (hijo) desde el micrositio; al terminar se regresa a reservar. */
export function additionalPatientPage(options: {
  slug: string;
  doctorName: string;
  csrf: string;
  values: Readonly<Record<string, string>>;
  errors: FieldErrors;
}): string {
  const { values, errors } = options;
  const content = html`<h1>${options.doctorName}</h1>
<h2>Añadir un paciente adicional</h2>
${errorList(errors._)}
${form({
  action: `/c/${options.slug}/paciente-adicional`,
  csrf: options.csrf,
  children: [
    textInput({ name: "fullName", label: "Nombre completo", value: values.fullName ?? "", required: true, errors: errors.fullName }),
    textInput({ name: "birthDate", label: "Fecha de nacimiento", type: "date", value: values.birthDate ?? "", required: true, errors: errors.birthDate }),
    textInput({ name: "phone", label: "Teléfono (opcional)", type: "tel", value: values.phone ?? "", errors: errors.phone }),
    checkbox({
      name: "acceptPrivacyOnBehalf",
      label: html`Como tutor, acepto en nombre del menor el <a href="/legal/patient_privacy" target="_blank" rel="noopener">aviso de privacidad</a> y doy mi consentimiento expreso para el tratamiento de sus datos de salud`,
      errors: errors.acceptPrivacyOnBehalf,
    }),
    submitButton("Añadir paciente"),
  ],
})}
<p><a href="/c/${options.slug}/reservar">Volver a reservar</a></p>`;
  return sitePage({ title: options.doctorName, content });
}

// --- Enlaces de correo de una cita ----------------------------------------------------------------------------------------

/** Respuesta ÚNICA (410) para cualquier enlace que no sirva: no distingue vencido, usado, ajeno ni cancelado. */
export function appointmentLinkGonePage(): string {
  return sitePage({
    title: "Enlace no disponible",
    content: html`<h1>Este enlace ya no es válido</h1>
<p>Puede haber vencido, o la cita ya se canceló o ya pasó. Si necesitas ayuda, comunícate directamente con el consultorio.</p>
<p><a href="/pacientes/citas">Ver mis citas</a></p>`,
  });
}

/** Inicio de sesión del paciente para abrir el enlace; al entrar regresa al mismo enlace. */
export function appointmentLinkLoginPage(options: { token: string; csrf: string; email: string; error?: string }): string {
  return sitePage({
    title: "Inicia sesión para ver tu cita",
    content: html`<h1>Inicia sesión para ver tu cita</h1>
${options.error ? errorList([options.error]) : null}
${form({
  action: `/citas/enlace/${encodeURIComponent(options.token)}/entrar`,
  csrf: options.csrf,
  children: [
    textInput({ name: "email", label: "Correo", type: "email", value: options.email, autocomplete: "username", required: true }),
    passwordInput({ name: "password", label: "Contraseña", autocomplete: "current-password", required: true }),
    submitButton("Entrar"),
  ],
})}
<p><a href="/recuperar">¿Olvidaste tu contraseña?</a></p>`,
  });
}

/** Resumen de la cita. Abrir el enlace nunca cambia nada: cancelar es un botón (con protección CSRF) que exige sesión. */
export function appointmentLinkSummaryPage(options: { token: string; csrf: string; summary: AppointmentSummary; notice?: string }): string {
  const { summary } = options;
  const phone = phoneNotice(summary.officePhone);
  return sitePage({
    title: "Tu cita",
    content: html`<h1>Tu cita dental</h1>
${options.notice ? html`<p role="alert">${options.notice}</p>` : null}
<dl>
  <dt>Paciente</dt><dd>${summary.patientName}</dd>
  <dt>Con</dt><dd>${summary.doctorName}</dd>
  <dt>Fecha</dt><dd>${formatDate(summary.timezone, summary.startUtc)}</dd>
  <dt>Hora</dt><dd>${formatTime(summary.timezone, summary.startUtc)} (hora del consultorio)</dd>
  ${summary.address ? html`<dt>Dónde</dt><dd>${summary.address}</dd>` : null}
</dl>
${phone}
${summary.cancelable
  ? html`<p>Puedes cancelar hasta ${formatDate(summary.timezone, summary.cancelDeadline)}, ${formatTime(summary.timezone, summary.cancelDeadline)}.</p>
${form({
  action: `/citas/enlace/${encodeURIComponent(options.token)}/cancelar`,
  csrf: options.csrf,
  children: [submitButton("Cancelar mi cita")],
})}`
  : html`<p>Ya pasó el plazo para cancelar en línea. Si no vas a poder asistir, llama al consultorio.</p>`}
<p><a href="/pacientes/citas">Ver todas mis citas</a></p>`,
  });
}

// --- Mis citas (paciente) ---------------------------------------------------------------------------------------------------

function appointmentRow(item: PatientAppointmentItem): SafeHtml {
  return html`<li><a href="/pacientes/citas/${item.id}">${formatDate(item.timezone, item.startUtc)}, ${formatTime(item.timezone, item.startUtc)}</a>
  — ${item.patientName} con ${item.doctorName}${item.kind === "urgent" ? html` <strong>Urgencia</strong>` : null}${item.status === "cancelled" ? " (cancelada)" : ""}</li>`;
}

/** «Mis citas»: próximas e historial reciente de todas las personas de la cuenta, con cualquier consultorio. */
export function myAppointmentsPage(list: PatientAppointmentList, notice?: string): string {
  return sitePage({
    title: "Mis citas",
    content: html`<h1>Mis citas</h1>
${notice ? html`<p role="alert">${notice}</p>` : null}
<h2>Próximas</h2>
${list.upcoming.length === 0 ? html`<p>No tienes citas próximas.</p>` : html`<ul>${list.upcoming.map(appointmentRow)}</ul>`}
<h2>Historial (últimos 90 días)</h2>
${list.history.length === 0 ? html`<p>Sin citas recientes.</p>` : html`<ul>${list.history.map(appointmentRow)}</ul>`}
<p><a href="/pacientes/consultorios">Mis consultorios</a> · <a href="/pacientes/panel">Mi cuenta</a></p>`,
  });
}

/** Detalle de una cita de la cuenta, con el botón de cancelar si todavía se puede. */
export function patientAppointmentPage(options: { item: PatientAppointmentItem; csrf: string; notice?: string }): string {
  const { item } = options;
  return sitePage({
    title: "Mi cita",
    content: html`<h1>Mi cita</h1>
${options.notice ? html`<p role="alert">${options.notice}</p>` : null}
<dl>
  <dt>Paciente</dt><dd>${item.patientName}</dd>
  <dt>Con</dt><dd>${item.doctorName}</dd>
  <dt>Fecha</dt><dd>${formatDate(item.timezone, item.startUtc)}</dd>
  <dt>Hora</dt><dd>${formatTime(item.timezone, item.startUtc)} (hora del consultorio)</dd>
  ${item.address ? html`<dt>Dónde</dt><dd>${item.address}</dd>` : null}
  <dt>Estado</dt><dd>${item.status === "cancelled" ? "Cancelada" : "Agendada"}</dd>
  <dt>Tipo</dt><dd>${item.kind === "urgent" ? "Urgencia" : "Convencional"}</dd>
</dl>
${phoneNotice(item.officePhone)}
${item.cancelable
  ? html`<p>Puedes cancelar hasta ${formatDate(item.timezone, item.cancelDeadline)}, ${formatTime(item.timezone, item.cancelDeadline)}.</p>
${form({ action: `/pacientes/citas/${item.id}/cancelar`, csrf: options.csrf, children: [submitButton("Cancelar mi cita")] })}`
  : item.live
    ? html`<p>Ya pasó el plazo para cancelar en línea. Si no vas a poder asistir, llama al consultorio.</p>`
    : null}
<p><a href="/pacientes/citas">Volver a mis citas</a></p>`,
  });
}

// --- Mis consultorios y revocación del vínculo ------------------------------------------------------------------------------

const OFFICE_ORIGIN_LABEL = { patient: "Lo creaste tú", office: "Lo creó el consultorio" } as const;

/** «Mis consultorios»: quién ve los datos de contacto de las personas de la cuenta. */
export function myOfficesPage(offices: readonly OfficeItem[]): string {
  return sitePage({
    title: "Mis consultorios",
    content: html`<h1>Mis consultorios</h1>
<p>Estos consultorios pueden ver el nombre y los datos de contacto (correo y teléfono) de los pacientes de tu cuenta para atender tus citas.</p>
${offices.length === 0
  ? html`<p>Ningún consultorio tiene acceso a tus datos de contacto.</p>`
  : html`<ul>${offices.map(
      (office) => html`<li>${office.doctorName} — ${OFFICE_ORIGIN_LABEL[office.origin]}, desde ${formatDate("America/Mexico_City", office.linkedAt)}
  · <a href="/pacientes/consultorios/${office.doctorId}/revocar">Revocar</a></li>`,
    )}</ul>`}
<p><a href="/pacientes/citas">Mis citas</a></p>`,
  });
}

/** Confirmación previa a revocar: qué se cancelará y qué deja de ver el consultorio. */
export function revokeOfficePage(options: { doctorId: number; doctorName: string; futureAppointments: number; csrf: string }): string {
  const count = options.futureAppointments;
  return sitePage({
    title: "Revocar el vínculo con un consultorio",
    content: html`<h1>Revocar el vínculo con ${options.doctorName}</h1>
<ul>
  <li>${count === 0 ? "No tienes citas futuras con este consultorio." : count === 1 ? "Se cancelará 1 cita futura con este consultorio (el consultorio recibirá el aviso)." : `Se cancelarán ${count} citas futuras con este consultorio (el consultorio recibirá el aviso).`}</li>
  <li>El consultorio dejará de ver los datos de contacto (correo y teléfono) de las personas de tu cuenta.</li>
  <li>Conservará el nombre en las citas que ya pasaron.</li>
  <li>Podrás volver a reservar con este consultorio cuando quieras; se te pedirá autorizar de nuevo.</li>
</ul>
${form({ action: `/pacientes/consultorios/${options.doctorId}/revocar`, csrf: options.csrf, children: [submitButton("Revocar el vínculo")] })}
<p><a href="/pacientes/consultorios">Cancelar y volver</a></p>`,
  });
}
