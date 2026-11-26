import { html, type SafeHtml } from "../../lib/html.js";
import { formatLocalInstant, localToUtc, utcToLocal } from "../../lib/zoned-time.js";
import type { AgendaDay, AgendaWeek } from "../../modules/calendar/agenda-service.js";
import { csrfInput, errorList } from "./forms.js";
import { page } from "./layout.js";
import { alert, appointmentBadge, badge, badgeOf, definitionList, emptyState, tableWrap, type BadgeVariant } from "./ui.js";

// --- Formato en la zona del consultorio (las horas se guardan en UTC y solo se muestran convertidas) ---------------

const timeFormatters = new Map<string, Intl.DateTimeFormat>();
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

/** Hora local `HH:MM` de un instante en la zona del consultorio. */
export function formatTime(zone: string, instant: Date): string {
  let formatter = timeFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("es-MX", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    timeFormatters.set(zone, formatter);
  }
  return formatter.format(instant);
}

/** Fecha larga en español (por ejemplo «lunes, 15 de junio de 2026») en la zona del consultorio. */
export function formatDate(zone: string, instant: Date): string {
  let formatter = dateFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("es-MX", { timeZone: zone, dateStyle: "full" });
    dateFormatters.set(zone, formatter);
  }
  return formatter.format(instant);
}

export function formatDateTime(zone: string, instant: Date): string {
  return `${formatDate(zone, instant)}, ${formatTime(zone, instant)}`;
}

// --- Diseño común de las pantallas de agenda ------------------------------------------------------------------------

/**
 * Página de agenda. La navegación (Agenda, Bloqueos y, solo para el médico, Configuración) la arma ahora la barra
 * lateral común (`shell.ts`); `canConfigure` se conserva en la firma porque los llamadores ya lo pasan.
 */
export function calendarLayout(options: { title: string; content: SafeHtml; canConfigure: boolean }): string {
  return page({ title: options.title, content: options.content });
}

// --- Configuración del calendario ------------------------------------------------------------------------------------

export const WEEKDAY_NAMES = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"] as const;

const TIMEZONE_LABELS: Readonly<Record<string, string>> = {
  "America/Mexico_City": "Ciudad de México (centro)",
  "America/Cancun": "Cancún (sureste)",
  "America/Merida": "Mérida",
  "America/Monterrey": "Monterrey",
  "America/Chihuahua": "Chihuahua",
  "America/Ciudad_Juarez": "Ciudad Juárez",
  "America/Hermosillo": "Hermosillo (Sonora)",
  "America/Mazatlan": "Mazatlán (Pacífico)",
  "America/Tijuana": "Tijuana (noroeste)",
  "America/Matamoros": "Matamoros",
  "America/Bahia_Banderas": "Bahía de Banderas",
  "America/Ojinaga": "Ojinaga",
};

type FieldErrors = Readonly<Record<string, readonly string[]>>;

function minutesText(total: number): string {
  const hours = Math.floor(total / 60);
  return `${String(hours).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** Valores del formulario (mismos nombres que el cuerpo del `POST`) a partir de la configuración guardada. */
export function configFormValues(config: {
  settings: { slotMinutes: number; gapMinutes: number; timezone: string; minNoticeMinutes: number; maxAdvanceDays: number; cancelNoticeHours: number; urgentMinNoticeMinutes: number };
  hours: readonly { weekday: number; startMinute: number; endMinute: number; kind?: "regular" | "urgent" }[];
}): Record<string, string> {
  const values: Record<string, string> = {
    slotMinutes: String(config.settings.slotMinutes),
    gapMinutes: String(config.settings.gapMinutes),
    timezone: config.settings.timezone,
    minNoticeHours: String(Math.floor(config.settings.minNoticeMinutes / 60)),
    maxAdvanceDays: String(config.settings.maxAdvanceDays),
    cancelNoticeHours: String(config.settings.cancelNoticeHours),
    urgentMinNoticeMinutes: String(config.settings.urgentMinNoticeMinutes),
  };
  const used = new Map<string, number>();
  for (const range of config.hours) {
    const prefix = range.kind === "urgent" ? "u" : "h";
    const counter = `${prefix}${range.weekday}`;
    const slot = used.get(counter) ?? 0;
    used.set(counter, slot + 1);
    if (slot > (prefix === "u" ? 1 : 3)) continue;
    values[`${prefix}${range.weekday}_${slot}_start`] = minutesText(range.startMinute);
    values[`${prefix}${range.weekday}_${slot}_end`] = minutesText(range.endMinute);
  }
  return values;
}

function numberField(name: string, label: string, values: Record<string, string>, errors: FieldErrors, hint: string): SafeHtml {
  return html`<p>
  <label>${label}
    <input type="text" inputmode="numeric" name="${name}" value="${values[name] ?? ""}" required>
  </label>
  <small>${hint}</small>
  ${errorList(errors[name])}
</p>`;
}

/** Pantalla de configuración del calendario (solo el médico). Repinta los valores escritos si hubo errores. */
export function configurationPage(options: {
  csrf: string;
  values: Record<string, string>;
  errors?: FieldErrors;
  allowedTimezones: readonly string[];
  isDefault: boolean;
  saved?: boolean;
}): string {
  const errors = options.errors ?? {};
  const values = options.values;
  const dayRows = WEEKDAY_NAMES.map((name, index) => {
    const weekday = index + 1;
    const slots = [0, 1, 2, 3].map((slot) => {
      const key = `h${weekday}_${slot}`;
      return html`<span>
  <input type="text" name="${key}_start" value="${values[`${key}_start`] ?? ""}" placeholder="09:00" size="5" aria-label="${name}, franja ${slot + 1}, inicio">
  a
  <input type="text" name="${key}_end" value="${values[`${key}_end`] ?? ""}" placeholder="14:00" size="5" aria-label="${name}, franja ${slot + 1}, fin">
  ${errorList(errors[key])}
</span>`;
    });
    return html`<li><strong>${name}</strong> ${slots}</li>`;
  });
  const urgentRows = WEEKDAY_NAMES.map((name, index) => {
    const weekday = index + 1;
    const slots = [0, 1].map((slot) => {
      const key = `u${weekday}_${slot}`;
      return html`<span>
  <input type="text" name="${key}_start" value="${values[`${key}_start`] ?? ""}" placeholder="08:00" size="5" aria-label="${name}, urgencias, franja ${slot + 1}, inicio">
  a
  <input type="text" name="${key}_end" value="${values[`${key}_end`] ?? ""}" placeholder="09:00" size="5" aria-label="${name}, urgencias, franja ${slot + 1}, fin">
  ${errorList(errors[key])}
</span>`;
    });
    return html`<li><strong>${name}</strong> ${slots}</li>`;
  });
  const content = html`<h1>Configuración del calendario</h1>
${options.saved ? alert("success", "Configuración guardada. Las citas ya agendadas no cambian.") : null}
${options.isDefault ? alert("info", "Todavía no guardas tu configuración: se usan los valores por defecto y no hay horario de atención, así que aún no hay espacios.") : null}
<form method="post" action="/agenda/configuracion">
${csrfInput(options.csrf)}
<fieldset><legend>Citas</legend>
${numberField("slotMinutes", "Duración de cada cita (minutos)", values, errors, "De 15 a 180, en pasos de 5.")}
${numberField("gapMinutes", "Pausa entre citas (minutos)", values, errors, "De 0 a 60, en pasos de 5. Los espacios empiezan cada duración + pausa.")}
<p>
  <label>Zona horaria del consultorio
    <select name="timezone">
      ${options.allowedTimezones.map((zone) => html`<option value="${zone}"${values.timezone === zone ? html` selected` : null}>${TIMEZONE_LABELS[zone] ?? zone}</option>`)}
    </select>
  </label>
  ${errorList(errors.timezone)}
</p>
</fieldset>
<fieldset><legend>Reservas de pacientes</legend>
${numberField("minNoticeHours", "Anticipación mínima (horas)", values, errors, "De 0 a 168 horas (7 días).")}
${numberField("maxAdvanceDays", "Anticipación máxima (días)", values, errors, "De 1 a 365 días hacia adelante.")}
${numberField("cancelNoticeHours", "Límite para que el paciente cancele (horas antes de la cita)", values, errors, "De 0 a 168 horas; 24 por defecto. Pasado el límite, el paciente debe llamar al consultorio.")}
</fieldset>
<fieldset><legend>Horario de atención</legend>
<p>Hasta 4 franjas por día en formato 24 horas (HH:MM, minutos de 5 en 5). Deja vacío un día sin atención.</p>
<ul class="hours">${dayRows}</ul>
</fieldset>
<fieldset><legend>Urgencias</legend>
<p>Horarios que reservas solo para urgencias: no aparecen en el calendario de tus pacientes. Hasta 2 franjas por día, sin solaparse con tu horario de atención ni entre sí. Los espacios usan la misma duración y pausa de tus citas.</p>
${numberField("urgentMinNoticeMinutes", "Anticipación mínima de una urgencia (minutos)", values, errors, "De 0 a 1440 minutos; 30 por defecto.")}
<ul class="hours">${urgentRows}</ul>
</fieldset>
<div class="form-actions"><button type="submit">Guardar configuración</button></div>
</form>`;
  return calendarLayout({ title: "Configuración del calendario", content, canConfigure: true });
}

// --- Agenda por día y por semana ---------------------------------------------------------------------------------------

const STATE_LABELS: Readonly<Record<string, string>> = {
  free: "Libre",
  booked: "Ocupado",
  blocked: "Bloqueado",
  past: "Pasado",
};

const STATE_VARIANTS: Readonly<Record<string, BadgeVariant>> = {
  free: "neutral",
  booked: "confirmed",
  blocked: "pending",
  past: "neutral",
};

/** Fecha larga de un día local (se formatea el mediodía local, que existe en cualquier zona). */
function dateLabel(zone: string, localDate: string): string {
  const noon = localToUtc(zone, localDate, 12 * 60);
  return noon ? formatDate(zone, noon) : localDate;
}

function appointmentName(day: AgendaDay, appointmentId: number | undefined): SafeHtml | null {
  if (appointmentId === undefined) return null;
  const appointment = day.appointments.find((candidate) => candidate.id === appointmentId);
  return html`<a href="/agenda/citas/${appointmentId}">${appointment?.patientName ?? "Ver cita"}</a>${appointment?.kind === "urgent" ? html` <strong>Urgencia</strong>` : null}`;
}

/** Acciones de un espacio libre: agendar (enlace) y bloquearlo (formulario con CSRF). */
function freeSlotActions(day: AgendaDay, slot: AgendaDay["slots"][number], csrf: string): SafeHtml {
  const startLocal = formatLocalInstant(day.timezone, slot.startUtc);
  return html`<a class="btn" href="/agenda/citas/nueva?inicio=${encodeURIComponent(startLocal)}">Agendar</a>
  <form method="post" action="/agenda/bloqueos/espacio" class="inline">${csrfInput(csrf)}<input type="hidden" name="inicio" value="${startLocal}"><button type="submit" class="btn-secondary">Bloquear</button></form>`;
}

function slotRows(day: AgendaDay, csrf: string): SafeHtml[] {
  return day.slots.map(
    (slot) => html`<tr>
  <td>${formatTime(day.timezone, slot.startUtc)} – ${formatTime(day.timezone, slot.endUtc)}${slot.kind === "urgent" ? html` <strong>Urgencia</strong>` : null}</td>
  <td>${badge(STATE_VARIANTS[slot.state] ?? "neutral", STATE_LABELS[slot.state] ?? slot.state)}</td>
  <td>${appointmentName(day, slot.appointmentId)}</td>
  <td>${slot.state === "free" ? freeSlotActions(day, slot, csrf) : null}</td>
</tr>`,
  );
}

function outOfScheduleSection(day: AgendaDay): SafeHtml | null {
  const outside = day.appointments.filter((appointment) => appointment.outOfSchedule);
  if (outside.length === 0) return null;
  return html`<h3>Citas fuera del horario actual</h3>
<p>Estas citas se conservan, pero ya no coinciden con tu configuración actual.</p>
<ul>${outside.map(
    (appointment) => html`<li>${formatTime(day.timezone, appointment.startUtc)} – ${formatTime(day.timezone, appointment.endUtc)}
  <a href="/agenda/citas/${appointment.id}">${appointment.patientName}</a> ${badge("pending", "Fuera del horario actual")}</li>`,
  )}</ul>`;
}

function blocksSection(day: AgendaDay, csrf: string): SafeHtml | null {
  if (day.blocks.length === 0) return null;
  return html`<h3>Bloqueos</h3>
<ul>${day.blocks.map(
    (block) => html`<li>${formatDateTime(day.timezone, block.startUtc)} – ${formatDateTime(day.timezone, block.endUtc)}${block.reason ? html` · ${block.reason}` : null}
  <form method="post" action="/agenda/bloqueos/${block.id}/eliminar" class="inline">${csrfInput(csrf)}<button type="submit" class="btn-danger">Quitar bloqueo</button></form></li>`,
  )}</ul>`;
}

function daySection(day: AgendaDay, headingLevel: "h1" | "h2", csrf: string): SafeHtml {
  const label = dateLabel(day.timezone, day.date);
  const heading = headingLevel === "h1" ? html`<h1>${label}</h1>` : html`<h2><a href="/agenda/dia/${day.date}">${label}</a></h2>`;
  return html`${heading}
${day.slots.length === 0
    ? emptyState({ title: "Sin espacios este día" })
    : tableWrap(html`<table>
  <thead><tr><th scope="col">Horario</th><th scope="col">Estado</th><th scope="col">Paciente</th><th scope="col">Acciones</th></tr></thead>
  <tbody>${slotRows(day, csrf)}</tbody>
</table>`)}
${outOfScheduleSection(day)}
${blocksSection(day, csrf)}`;
}

/** Vista de un día. */
export function dayPage(options: { day: AgendaDay; csrf: string; canConfigure: boolean }): string {
  const { day } = options;
  const content = html`<p class="date-nav">
  <a class="btn btn-secondary" href="/agenda/dia/${day.previousDate}">← Día anterior</a>
  <a class="btn btn-secondary" href="/agenda">Hoy</a>
  <a class="btn btn-secondary" href="/agenda/dia/${day.nextDate}">Día siguiente →</a>
  <a class="btn btn-secondary" href="/agenda/semana/${day.date}">Ver la semana</a>
</p>
${daySection(day, "h1", options.csrf)}`;
  return calendarLayout({ title: `Agenda del ${day.date}`, content, canConfigure: options.canConfigure });
}

/** Vista de una semana (lunes a domingo). */
export function weekPage(options: { week: AgendaWeek; csrf: string; canConfigure: boolean }): string {
  const { week } = options;
  const first = week.days[0];
  const last = week.days[6];
  const content = html`<h1>Semana del ${first ? dateLabel(week.timezone, first.date) : week.startDate} al ${last ? dateLabel(week.timezone, last.date) : ""}</h1>
<p class="date-nav">
  <a class="btn btn-secondary" href="/agenda/semana/${week.previousDate}">← Semana anterior</a>
  <a class="btn btn-secondary" href="/agenda">Hoy</a>
  <a class="btn btn-secondary" href="/agenda/semana/${week.nextDate}">Semana siguiente →</a>
</p>
${week.days.map((day) => html`<section>${daySection(day, "h2", options.csrf)}</section>`)}`;
  return calendarLayout({ title: `Agenda de la semana del ${week.startDate}`, content, canConfigure: options.canConfigure });
}

// --- Nueva cita y detalle de cita --------------------------------------------------------------------------------------

export interface PickerPatient {
  patientId: number;
  fullName: string;
}

export interface LookupPatient extends PickerPatient {
  ticket: string;
}

/** Pantalla para elegir al paciente de un espacio libre: vinculados, búsqueda por correo y, si la hubo, sus resultados. */
export function newAppointmentPage(options: {
  csrf: string;
  startLocal: string;
  whenLabel: string;
  linkedPatients: readonly PickerPatient[];
  lookup?: { email: string; patients: readonly LookupPatient[] } | null;
  canConfigure: boolean;
}): string {
  const linked =
    options.linkedPatients.length === 0
      ? alert("info", "Todavía no tienes pacientes vinculados. Busca la cuenta por su correo.")
      : html`<form method="post" action="/agenda/citas">
${csrfInput(options.csrf)}
<input type="hidden" name="inicio" value="${options.startLocal}">
<fieldset>
  <legend>Pacientes del consultorio</legend>
  ${options.linkedPatients.map(
    (patient, index) => html`<p><label><input type="radio" name="patientId" value="${patient.patientId}"${index === 0 ? html` required` : null}> ${patient.fullName}</label></p>`,
  )}
</fieldset>
<button type="submit">Agendar cita</button>
</form>`;

  const lookup = options.lookup;
  const results = !lookup
    ? null
    : lookup.patients.length === 0
      ? alert("warning", "No encontramos una cuenta con ese correo.")
      : html`<h3>Pacientes de esa cuenta</h3>
${lookup.patients.map(
  (patient) => html`<form method="post" action="/agenda/citas">
${csrfInput(options.csrf)}
<input type="hidden" name="inicio" value="${options.startLocal}">
<input type="hidden" name="patientId" value="${patient.patientId}">
<input type="hidden" name="ticket" value="${patient.ticket}">
<button type="submit" class="btn-secondary">Agendar a ${patient.fullName}</button>
</form>`,
)}`;

  const content = html`<h1>Nueva cita</h1>
<p>${options.whenLabel}</p>
${linked}
<h2>Buscar a un paciente por su correo</h2>
<p>Escribe el correo exacto con el que el paciente creó su cuenta.</p>
<form method="post" action="/agenda/citas/buscar">
${csrfInput(options.csrf)}
<input type="hidden" name="inicio" value="${options.startLocal}">
<p><label>Correo de la cuenta <input type="email" name="email" value="${lookup?.email ?? ""}" required maxlength="254"></label></p>
<button type="submit" class="btn-secondary">Buscar</button>
</form>
${results}
<p><a href="/agenda/dia/${options.startLocal.slice(0, 10)}">Volver a la agenda</a></p>`;
  return calendarLayout({ title: "Nueva cita", content, canConfigure: options.canConfigure });
}

/** Resumen de una cita: solo el nombre del paciente; el resto de sus datos está en la ruta auditada. */
export function appointmentDetailPage(options: {
  csrf: string;
  id: number;
  patientId: number;
  patientName: string;
  timezone: string;
  startUtc: Date;
  endUtc: Date;
  status: "booked" | "cancelled";
  kind: "regular" | "urgent";
  createdByRole: "doctor" | "reception" | "patient";
  cancelledByRole: "doctor" | "reception" | "patient" | null;
  cancelledAt: Date | null;
  cancelable: boolean;
  canConfigure: boolean;
}): string {
  const roleLabel = (role: "doctor" | "reception" | "patient"): string => (role === "doctor" ? "el médico" : role === "reception" ? "recepción" : "el paciente");
  const content = html`<h1>Cita</h1>
${definitionList([
  ["Paciente", html`${options.patientName} · <a href="/agenda/pacientes/${options.patientId}">Ver datos de contacto</a>`],
  ["Fecha", formatDate(options.timezone, options.startUtc)],
  ["Horario", `${formatTime(options.timezone, options.startUtc)} – ${formatTime(options.timezone, options.endUtc)}`],
  ["Estado", badgeOf(appointmentBadge(options.status))],
  ["Tipo", options.kind === "urgent" ? "Urgencia" : "Convencional"],
  ["Agendada por", roleLabel(options.createdByRole)],
  ...(options.cancelledAt && options.cancelledByRole
    ? ([["Cancelada por", `${roleLabel(options.cancelledByRole)}, ${formatDateTime(options.timezone, options.cancelledAt)}`]] as const)
    : []),
])}
${options.cancelable
    ? html`<form method="post" action="/agenda/citas/${options.id}/cancelar">
${csrfInput(options.csrf)}
<p>Al cancelar, el espacio queda libre y el paciente recibe un aviso por correo.</p>
<button type="submit" class="btn-danger">Cancelar cita</button>
</form>`
    : null}
<p><a href="/agenda/dia/${utcDateHint(options.timezone, options.startUtc)}">Volver a la agenda</a></p>`;
  return calendarLayout({ title: "Cita", content, canConfigure: options.canConfigure });
}

function utcDateHint(zone: string, instant: Date): string {
  return utcToLocal(zone, instant).date;
}

// --- Bloqueos -------------------------------------------------------------------------------------------------------------

export interface BlockListItem {
  id: number;
  startUtc: Date;
  endUtc: Date;
  reason: string | null;
  createdByRole: "doctor" | "reception";
}

function blockField(name: string, label: string, values: Record<string, string>, errors: FieldErrors, options: { placeholder: string; size?: number }): SafeHtml {
  return html`<label>${label}
    <input type="text" name="${name}" value="${values[name] ?? ""}" placeholder="${options.placeholder}" size="${options.size ?? 10}" required>
  </label>`;
}

/** Bloqueos vigentes o futuros y el formulario para crear uno (repinta lo escrito si hubo errores). */
export function blocksPage(options: {
  csrf: string;
  timezone: string;
  blocks: readonly BlockListItem[];
  values?: Record<string, string>;
  errors?: FieldErrors;
  canConfigure: boolean;
}): string {
  const values = options.values ?? {};
  const errors = options.errors ?? {};
  const list =
    options.blocks.length === 0
      ? emptyState({ title: "No hay bloqueos vigentes ni futuros" })
      : html`<ul class="appointments">${options.blocks.map(
          (block) => html`<li>${formatDateTime(options.timezone, block.startUtc)} – ${formatDateTime(options.timezone, block.endUtc)}${block.reason ? html` · ${block.reason}` : null}
  (${block.createdByRole === "doctor" ? "médico" : "recepción"})
  <form method="post" action="/agenda/bloqueos/${block.id}/eliminar" class="inline">${csrfInput(options.csrf)}<button type="submit" class="btn-danger">Quitar bloqueo</button></form></li>`,
        )}</ul>`;
  const content = html`<h1>Bloqueos de horario</h1>
<p>Solo se pueden bloquear horarios sin citas. Si el horario incluye citas, cancélalas primero (el paciente recibe un aviso) y vuelve a intentar.</p>
${list}
<h2>Bloquear un horario</h2>
<form method="post" action="/agenda/bloqueos">
${csrfInput(options.csrf)}
<p>${blockField("desdeFecha", "Desde (fecha AAAA-MM-DD)", values, errors, { placeholder: "2026-07-01" })}
${blockField("desdeHora", "hora (HH:MM)", values, errors, { placeholder: "09:00", size: 5 })}
${errorList(errors.desde)}</p>
<p>${blockField("hastaFecha", "Hasta (fecha AAAA-MM-DD)", values, errors, { placeholder: "2026-07-15" })}
${blockField("hastaHora", "hora (HH:MM)", values, errors, { placeholder: "19:00", size: 5 })}
${errorList(errors.hasta)}</p>
<p><label>Motivo (opcional, solo lo ve el consultorio)
  <input type="text" name="motivo" value="${values.motivo ?? ""}" maxlength="200">
</label>
${errorList(errors.motivo)}</p>
${errorList(errors.inicio)}
<button type="submit">Bloquear horario</button>
</form>`;
  return calendarLayout({ title: "Bloqueos de horario", content, canConfigure: options.canConfigure });
}

/** Se intentó bloquear un horario con citas: no se bloqueó nada; se listan las citas que hay que cancelar primero. */
export function blockConflictPage(options: {
  timezone: string;
  appointments: readonly { id: number; startUtc: Date; endUtc: Date; patientName: string }[];
  total: number;
  canConfigure: boolean;
}): string {
  const content = html`<h1>No se bloqueó el horario</h1>
${alert("warning", `Ese horario incluye ${options.total === 1 ? "una cita" : `${options.total} citas`}. Cancela estas citas y vuelve a intentar.`)}
<ul class="appointments">${options.appointments.map(
    (appointment) => html`<li>${formatDateTime(options.timezone, appointment.startUtc)} – ${formatTime(options.timezone, appointment.endUtc)}
  <a href="/agenda/citas/${appointment.id}">${appointment.patientName}</a></li>`,
  )}</ul>
${options.total > options.appointments.length ? html`<p>Se muestran las primeras ${options.appointments.length} de ${options.total}.</p>` : null}
<p><a href="/agenda/bloqueos">Volver a los bloqueos</a></p>`;
  return calendarLayout({ title: "No se bloqueó el horario", content, canConfigure: options.canConfigure });
}
