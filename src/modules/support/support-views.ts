import { html, type SafeHtml } from "../../lib/html.js";
import { csrfInput } from "../../http/views/forms.js";
import { page } from "../../http/views/layout.js";
import type { Doctor } from "../doctors/doctor-repository.js";
import type { DoctorOverview } from "./support-service.js";
import type { MailQueueSummary } from "./mail-queue-service.js";
import type { SiteList } from "./site-admin-service.js";
import type { MetricsResult } from "./metrics-service.js";
import type { HistoryPage } from "./action-log.js";
import { SLUG_RESERVATION_DAYS } from "../site/change-slug.js";

/** Aviso fijo junto a cada motivo: el historial es interno, pero no debe guardar datos de pacientes. */
export const REASON_WARNING = "No escribas datos de pacientes: el motivo queda en el historial.";

const NAV: ReadonlyArray<readonly [string, string]> = [
  ["/soporte", "Inicio"],
  ["/soporte/medicos", "Médicos"],
  ["/soporte/micrositios", "Micrositios"],
  ["/soporte/correos", "Correos"],
  ["/soporte/metricas", "Métricas"],
  ["/soporte/historial", "Historial"],
];

export function nav(): SafeHtml {
  return html`<nav aria-label="Panel de soporte">${NAV.map(([href, label], index) => html`${index > 0 ? " · " : null}<a href="${href}">${label}</a>`)}</nav>`;
}

/** Página del panel: navegación común más el contenido de la pantalla. */
export function supportPage(title: string, content: SafeHtml): string {
  return page({ title, content: html`${nav()}${content}` });
}

/** Mensaje de error (400 o 409) que se muestra sobre la pantalla desde la que se envió el formulario. */
export function errorNotice(messages: readonly string[]): SafeHtml {
  return html`<ul class="errors" role="alert">${messages.map((message) => html`<li>${message}</li>`)}</ul>`;
}

export interface ActionFormOptions {
  action: string;
  csrf: string;
  button: string;
  /** Estado que la persona está viendo; el servidor lo compara con el real (cambios de estado). */
  from?: string;
  /** Campos extra de solo lectura (por ejemplo, el nombre nuevo del enlace). */
  extra?: SafeHtml;
  errors?: readonly string[];
}

/** Formulario de una acción que cambia algo: motivo, casilla de confirmación y, si aplica, el estado visto. */
export function actionForm(options: ActionFormOptions): SafeHtml {
  return html`<form method="post" action="${options.action}">
${csrfInput(options.csrf)}
${options.from ? html`<input type="hidden" name="from" value="${options.from}">` : null}
${options.extra ?? null}
${options.errors && options.errors.length > 0 ? errorNotice(options.errors) : null}
<p><label>Motivo <input type="text" name="reason" required maxlength="500"></label><br><small>${REASON_WARNING}</small></p>
<p><label><input type="checkbox" name="confirm" value="yes"> Confirmo que quiero hacerlo</label></p>
<p><button type="submit">${options.button}</button></p>
</form>`;
}

/** Enlaces «anterior» y «siguiente» conservando los filtros. */
export function pager(basePath: string, query: Readonly<Record<string, string | number | undefined>>, current: number, hasNext: boolean): SafeHtml {
  const link = (pageNumber: number, label: string): SafeHtml => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "" && key !== "pagina") params.set(key, String(value));
    }
    params.set("pagina", String(pageNumber));
    return html`<a href="${basePath}?${params.toString()}">${label}</a>`;
  };
  return html`<p class="pager">${current > 1 ? link(current - 1, "← Anterior") : null}${current > 1 && hasNext ? " · " : null}${hasNext ? link(current + 1, "Siguiente →") : null}</p>`;
}

/** Fecha y hora en UTC, tal como se guarda (soporte no depende de la zona de un consultorio). */
export function formatUtc(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

// --- Médicos --------------------------------------------------------------------------------------------------------

export const APPROVAL_LABEL = { pending: "Pendiente", approved: "Aprobada", rejected: "Rechazada" } as const;
export const STATE_LABEL = { active: "Activa", suspended: "Suspendida", read_only: "Solo lectura" } as const;
export const SITE_LABEL = { draft: "Borrador", published: "Publicado", unpublished: "Despublicado" } as const;

const FILTERS: ReadonlyArray<readonly [string, string]> = [
  ["pending", "Pendientes"],
  ["approved", "Aprobadas"],
  ["active", "Activas"],
  ["read_only", "Solo lectura"],
  ["suspended", "Suspendidas"],
  ["rejected", "Rechazadas"],
  ["all", "Todas"],
];

export function doctorListView(options: { doctors: readonly Doctor[]; estado: string; q: string }): string {
  const rows = options.doctors.map(
    (d) => html`<tr><td><a href="/soporte/medicos/${d.id}">${d.fullName}</a></td><td>${APPROVAL_LABEL[d.approvalStatus]}</td><td>${d.approvalStatus === "approved" ? STATE_LABEL[d.accountState] : "—"}</td><td>${d.createdAt.toISOString().slice(0, 10)}</td></tr>`,
  );
  return supportPage(
    "Médicos",
    html`<h1>Médicos</h1>
<p>${FILTERS.map(([value, label], index) => html`${index > 0 ? " · " : null}<a href="/soporte/medicos?estado=${value}">${label}</a>`)}</p>
<form method="get" action="/soporte/medicos">
<input type="hidden" name="estado" value="${options.estado}">
<label>Buscar por nombre o correo del médico <input type="search" name="q" value="${options.q}" maxlength="100"></label>
<button type="submit">Buscar</button>
</form>
<table><thead><tr><th>Médico</th><th>Aprobación</th><th>Estado de la cuenta</th><th>Alta</th></tr></thead><tbody>${rows}</tbody></table>
${options.doctors.length === 0 ? html`<p>No hay médicos en este filtro.</p>` : null}`,
  );
}

export function doctorDetailView(options: { overview: DoctorOverview; csrf: string; errors?: readonly string[] }): string {
  const { doctor, site, futureAppointments } = options.overview;
  const action = (name: string) => `/soporte/medicos/${doctor.id}/${name}`;
  const approved = doctor.approvalStatus === "approved";
  const state = doctor.accountState;
  const buttons: SafeHtml[] = [];
  if (approved) {
    if (state === "active") {
      buttons.push(html`<h3>Poner en solo lectura</h3><p>El médico consulta su agenda, pero no cambia nada y su micrositio no acepta reservas nuevas.</p>${actionForm({ action: action("solo-lectura"), csrf: options.csrf, button: "Poner en solo lectura", from: state })}`);
    }
    if (state !== "suspended") {
      buttons.push(html`<h3>Suspender</h3><p>El médico pierde el acceso y su micrositio no acepta reservas. Sus citas agendadas se conservan.</p>${actionForm({ action: action("suspender"), csrf: options.csrf, button: "Suspender", from: state })}`);
    }
    if (state !== "active") {
      buttons.push(html`<h3>Reactivar</h3>${actionForm({ action: action("reactivar"), csrf: options.csrf, button: "Reactivar", from: state })}`);
    }
  }
  return supportPage(
    `Médico ${doctor.fullName}`,
    html`<h1>${doctor.fullName}</h1>
<p><a href="/soporte/medicos">← Volver a la lista</a></p>
${options.errors && options.errors.length > 0 ? errorNotice(options.errors) : null}
<dl>
  <dt>Aprobación</dt><dd>${APPROVAL_LABEL[doctor.approvalStatus]}</dd>
  ${approved ? html`<dt>Estado de la cuenta</dt><dd>${STATE_LABEL[state]}${doctor.accountStateChangedAt ? html` (cambio del ${formatUtc(doctor.accountStateChangedAt)})` : null}</dd>` : null}
  <dt>Correo</dt><dd>${doctor.email}</dd>
  <dt>Cédula</dt><dd>${doctor.cedulaNumber ?? "(liberada)"}</dd>
  <dt>Móvil de emergencias</dt><dd>${doctor.emergencyMobile ?? "(liberado)"}</dd>
  <dt>Teléfono del consultorio</dt><dd>${doctor.officePhone ?? "—"}</dd>
  <dt>Micrositio</dt><dd>${site ? html`${SITE_LABEL[site.status]} · /c/${site.slug}` : "Sin micrositio"}</dd>
  <dt>Citas futuras</dt><dd>${futureAppointments}</dd>
  <dt>Motivo de rechazo</dt><dd>${doctor.rejectionReason ?? "—"}</dd>
</dl>
<p><a href="/soporte/historial?objetivo=${doctor.id}">Ver historial de esta cuenta</a></p>
${doctor.cedulaFilePath ? html`<p><a href="${action("cedula")}" target="_blank" rel="noopener">Ver archivo de la cédula</a></p>` : html`<p>Sin archivo de cédula.</p>`}
${
  doctor.approvalStatus === "pending"
    ? html`<h3>Aprobar</h3><form method="post" action="${action("aprobar")}">${csrfInput(options.csrf)}
  <p><label><input type="checkbox" name="confirm" value="yes"> Confirmo que revisé la cédula y quiero aprobar esta cuenta</label></p>
  <button type="submit">Aprobar</button>
</form>
<h3>Rechazar</h3>${actionForm({ action: action("rechazar"), csrf: options.csrf, button: "Rechazar" })}`
    : null
}
${buttons}
<h3>Liberar cédula y móvil</h3>
<p><a href="${action("liberar-cedula")}">Revisar el efecto y liberar la cédula</a></p>`,
  );
}

// --- Micrositios y correos --------------------------------------------------------------------------------------------

const SITE_FILTERS: ReadonlyArray<readonly [string, string]> = [
  ["all", "Todos"],
  ["published", "Publicados"],
  ["draft", "Borradores"],
  ["unpublished", "Despublicados"],
];

export function sitesView(options: { list: SiteList; filter: string }): string {
  const rows = options.list.rows.map(
    (site) => html`<tr><td><a href="/soporte/medicos/${site.doctorId}">${site.doctorName}</a></td><td>/c/${site.slug}</td><td>${SITE_LABEL[site.status]}</td><td>${site.publishedAt ? formatUtc(site.publishedAt) : "—"}</td><td><a href="/soporte/micrositios/${site.doctorId}/enlace">Cambiar enlace</a></td></tr>`,
  );
  return supportPage(
    "Micrositios",
    html`<h1>Micrositios</h1>
<p>Publicados: ${options.list.counts.published} · Borradores: ${options.list.counts.draft} · Despublicados: ${options.list.counts.unpublished}</p>
<p>${SITE_FILTERS.map(([value, label], index) => html`${index > 0 ? " · " : null}<a href="/soporte/micrositios?estado=${value}">${label}</a>`)}</p>
<table><thead><tr><th>Médico</th><th>Enlace</th><th>Estado</th><th>Última publicación</th><th></th></tr></thead><tbody>${rows}</tbody></table>
${options.list.rows.length === 0 ? html`<p>No hay micrositios en este filtro.</p>` : null}`,
  );
}

export function slugFormView(options: { doctorId: number; doctorName: string; slug: string; csrf: string; errors?: readonly string[]; value?: string }): string {
  return supportPage(
    "Cambiar el enlace",
    html`<h1>Cambiar el enlace de ${options.doctorName}</h1>
<p><a href="/soporte/micrositios">← Volver a micrositios</a></p>
<p>Enlace actual: <strong>/c/${options.slug}</strong>. Al cambiarlo, el enlace anterior dejará de funcionar y quedará reservado ${SLUG_RESERVATION_DAYS} días para este consultorio. Se avisará al médico con el enlace nuevo.</p>
${actionForm({
  action: `/soporte/micrositios/${options.doctorId}/enlace`,
  csrf: options.csrf,
  button: "Cambiar enlace",
  extra: html`<p><label>Nombre nuevo (minúsculas, números y guiones) <input type="text" name="slug" value="${options.value ?? ""}" required minlength="3" maxlength="40"></label></p>`,
  ...(options.errors ? { errors: options.errors } : {}),
})}`,
  );
}

const ERROR_LABEL: Readonly<Record<string, string>> = {
  smtp_unreachable: "No se pudo conectar con el servidor de correo",
  smtp_rejected: "El servidor de correo rechazó el mensaje",
  smtp_timeout: "El servidor de correo tardó demasiado",
  template_error: "Error en la plantilla",
  other: "Otro error",
};

export function mailView(options: { summary: MailQueueSummary; csrf: string; now: Date }): string {
  const { summary } = options;
  const age = summary.oldestQueuedAt ? `${Math.max(0, Math.round((options.now.getTime() - summary.oldestQueuedAt.getTime()) / 60_000))} min` : "ninguno";
  const rows = summary.failed.map(
    (mail) => html`<tr><td>${mail.id}</td><td>${mail.template}</td><td>${mail.maskedTo}</td><td>${formatUtc(mail.createdAt)}</td><td>${mail.attempts}</td><td>${mail.errorCode ? (ERROR_LABEL[mail.errorCode] ?? "Otro error") : "—"}</td><td>${
      mail.retryable
        ? html`<details><summary>Reintentar o cancelar</summary>${actionForm({ action: `/soporte/correos/${mail.id}/reintentar`, csrf: options.csrf, button: "Reintentar" })}${actionForm({ action: `/soporte/correos/${mail.id}/cancelar`, csrf: options.csrf, button: "Cancelar el correo" })}</details>`
        : html`Aviso gestionado por la cola`
    }</td></tr>`,
  );
  return supportPage(
    "Correos",
    html`<h1>Cola de correos</h1>
<p>En cola: ${summary.counts.queued} · Enviados: ${summary.counts.sent} · Fallidos: ${summary.counts.failed} · Cancelados: ${summary.counts.cancelled}</p>
<p>Antigüedad del pendiente más viejo: ${age}</p>
<h2>Fallidos</h2>
<table><thead><tr><th>Id</th><th>Tipo</th><th>Destinatario</th><th>Fecha</th><th>Intentos</th><th>Motivo</th><th></th></tr></thead><tbody>${rows}</tbody></table>
${summary.failed.length === 0 ? html`<p>No hay correos fallidos.</p>` : null}
${pager("/soporte/correos", {}, summary.page, summary.hasNext)}`,
  );
}

// --- Métricas del piloto ------------------------------------------------------------------------------------------------

const PERIOD_LABEL: Readonly<Record<string, string>> = { semana: "Última semana", "4semanas": "Últimas 4 semanas", piloto: "Todo el piloto" };

function verdict(ok: boolean | null): string {
  return ok === null ? "sin datos" : ok ? "✓ se cumple" : "✗ no se cumple";
}

const valueOrNone = (value: number | null, suffix = ""): string => (value === null ? "sin datos" : `${value}${suffix}`);

export function metricsView(metrics: MetricsResult): string {
  const t = metrics.targets;
  const b = metrics.booking;
  const rows: Array<[string, string, string, string]> = [
    ["Finalización de reserva", valueOrNone(b.completionPercent, " %"), `más de ${t.completionPercent} %`, verdict(b.meetsCompletion)],
    ["Tiempo para reservar (promedio)", valueOrNone(b.averageSeconds, " s"), `menos de ${t.bookingSeconds} s`, verdict(b.meetsTime)],
    ["Reservas en menos de 2 minutos", valueOrNone(b.underTargetPercent, " %"), "—", "—"],
    ["Correos entregados", valueOrNone(metrics.mail.deliveredPercent, " %"), `más de ${t.deliveredPercent} %`, verdict(metrics.mail.meetsTarget)],
    ["Urgencias agendadas frente a «sin espacio»", metrics.urgent.scheduled + metrics.urgent.noSpace === 0 ? "sin datos" : `${metrics.urgent.scheduled} agendadas · ${metrics.urgent.noSpace} sin espacio`, "—", "—"],
    ["Posible abuso de urgencias (ahora)", `${metrics.urgentAbuse.patientsWithSeveralActive} pacientes con más de una urgencia vigente · ${metrics.urgentAbuse.accountsOverRequestLimit} cuentas con más de 3 solicitudes en 24 h`, "0", metrics.urgentAbuse.patientsWithSeveralActive + metrics.urgentAbuse.accountsOverRequestLimit === 0 ? "✓ sin señales" : "⚠ revisar"],
    ["Uso sostenido (médicos activos en las dos últimas semanas completas)", valueOrNone(metrics.sustainedUse.percent, " %"), `al menos ${t.sustainedUsePercent} %`, verdict(metrics.sustainedUse.meetsTarget)],
  ];
  return supportPage(
    "Métricas del piloto",
    html`<h1>Métricas del piloto</h1>
<p>${Object.entries(PERIOD_LABEL).map(([value, label], index) => html`${index > 0 ? " · " : null}<a href="/soporte/metricas?periodo=${value}">${label}</a>`)}</p>
<p>Periodo: ${PERIOD_LABEL[metrics.period]} (${metrics.from.toISOString().slice(0, 10)} a ${metrics.to.toISOString().slice(0, 10)}). Solo conteos y porcentajes: sin datos de pacientes.</p>
<table><thead><tr><th>Métrica</th><th>Valor</th><th>Meta</th><th>Cumplimiento</th></tr></thead><tbody>${rows.map(([name, value, target, ok]) => html`<tr><td>${name}</td><td>${value}</td><td>${target}</td><td>${ok}</td></tr>`)}</tbody></table>
<h2>Citas por médico y semana</h2>
${metrics.appointmentsPerDoctorWeek.length === 0 ? html`<p>sin datos</p>` : html`<table><thead><tr><th>Semana (lunes)</th><th>Médico</th><th>Citas</th></tr></thead><tbody>${metrics.appointmentsPerDoctorWeek.map((row) => html`<tr><td>${row.week}</td><td>${row.doctorName}</td><td>${row.count}</td></tr>`)}</tbody></table>`}
<h2>Médicos activos por semana</h2>
${metrics.activeDoctorsPerWeek.length === 0 ? html`<p>sin datos</p>` : html`<table><thead><tr><th>Semana (lunes)</th><th>Médicos activos</th></tr></thead><tbody>${metrics.activeDoctorsPerWeek.map((row) => html`<tr><td>${row.week}</td><td>${row.count}</td></tr>`)}</tbody></table>`}`,
  );
}

// --- Historial ----------------------------------------------------------------------------------------------------------

export const ACTION_LABEL: Readonly<Record<string, string>> = {
  approve: "Aprobó la cuenta",
  reject: "Rechazó la solicitud",
  release_cedula: "Liberó la cédula y el móvil",
  suspend: "Suspendió la cuenta",
  read_only: "Puso la cuenta en solo lectura",
  reactivate: "Reactivó la cuenta",
  change_slug: "Cambió el enlace del micrositio",
  retry_email: "Reintentó un correo",
  cancel_email: "Canceló un correo",
  view_cedula: "Consultó la cédula",
};
const TARGET_LABEL = { doctor: "Médico", site: "Micrositio", email: "Correo" } as const;

export function historyView(options: { page: HistoryPage; filters: Readonly<Record<string, string | number | undefined>> }): string {
  const { page: data, filters } = options;
  const rows = data.rows.map(
    (entry) => html`<tr><td>${formatUtc(entry.occurredAt)}</td><td>${entry.supportEmail}</td><td>${ACTION_LABEL[entry.action] ?? entry.action}</td><td>${TARGET_LABEL[entry.targetType]} ${entry.targetType === "email" ? `#${entry.targetId}` : html`<a href="/soporte/medicos/${entry.targetId}">#${entry.targetId}</a>`}</td><td>${entry.reason ?? "—"}</td></tr>`,
  );
  return supportPage(
    "Historial de acciones",
    html`<h1>Historial de acciones de soporte</h1>
<form method="get" action="/soporte/historial">
<label>Persona (id) <input type="number" name="persona" min="1" value="${filters.persona ?? ""}"></label>
<label>Acción <select name="accion"><option value="">Todas</option>${Object.entries(ACTION_LABEL).map(([value, label]) => html`<option value="${value}"${filters.accion === value ? html` selected` : null}>${label}</option>`)}</select></label>
<label>Desde <input type="date" name="desde" value="${filters.desde ?? ""}"></label>
<label>Hasta <input type="date" name="hasta" value="${filters.hasta ?? ""}"></label>
<button type="submit">Filtrar</button>
</form>
<table><thead><tr><th>Fecha</th><th>Persona</th><th>Acción</th><th>Objetivo</th><th>Motivo</th></tr></thead><tbody>${rows}</tbody></table>
${data.rows.length === 0 ? html`<p>No hay acciones con estos filtros.</p>` : null}
${pager("/soporte/historial", filters, data.page, data.hasNext)}`,
  );
}

// --- Liberar la cédula ---------------------------------------------------------------------------------------------------

export function releaseView(options: { overview: DoctorOverview; csrf: string }): string {
  const { doctor, site, futureAppointments } = options.overview;
  return supportPage(
    "Liberar la cédula",
    html`<h1>Liberar la cédula de ${doctor.fullName}</h1>
<p><a href="/soporte/medicos/${doctor.id}">← Volver al médico</a></p>
<p>Al liberar la cédula y el móvil de emergencias, la cuenta queda rechazada: el médico pierde el acceso a sus funciones y su micrositio deja de aceptar reservas hasta que registre otra cédula y se apruebe de nuevo. Se le avisa con un texto fijo.</p>
<dl>
  <dt>Cuenta</dt><dd>${APPROVAL_LABEL[doctor.approvalStatus]}</dd>
  <dt>Micrositio</dt><dd>${site ? html`${SITE_LABEL[site.status]} · /c/${site.slug}` : "Sin micrositio"}</dd>
  <dt>Citas futuras</dt><dd>${futureAppointments}</dd>
</dl>
<p>Las citas agendadas se conservan; sus pacientes pueden cancelarlas.</p>
${actionForm({ action: `/soporte/medicos/${doctor.id}/liberar-cedula`, csrf: options.csrf, button: "Liberar cédula y móvil" })}`,
  );
}
