import { html, type SafeHtml } from "../../lib/html.js";
import { csrfInput } from "../../http/views/forms.js";
import { page } from "../../http/views/layout.js";
import { alert, badge, definitionList, doctorAccountBadge, doctorApprovalBadge, emptyState, mailBadge, siteBadge, tableWrap } from "../../http/views/ui.js";
import type { Doctor } from "../doctors/doctor-repository.js";
import type { DoctorOverview } from "./support-service.js";
import type { MailQueueSummary } from "./mail-queue-service.js";
import type { SiteList } from "./site-admin-service.js";
import type { MetricsResult } from "./metrics-service.js";
import type { HistoryPage } from "./action-log.js";
import { SLUG_RESERVATION_DAYS } from "../site/change-slug.js";

/** Aviso fijo junto a cada motivo: el historial es interno, pero no debe guardar datos de pacientes. */
export const REASON_WARNING = "No escribas datos de pacientes: el motivo queda en el historial.";

/** Página del panel. La navegación del panel la arma la barra lateral común (`shell.ts`). */
export function supportPage(title: string, content: SafeHtml): string {
  return page({ title, content });
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
  /** `danger` para acciones que quitan acceso o descartan algo; `secondary` para las accesorias. */
  variant?: "danger" | "secondary";
}

/** Formulario de una acción que cambia algo: motivo, casilla de confirmación y, si aplica, el estado visto. */
export function actionForm(options: ActionFormOptions): SafeHtml {
  return html`<form method="post" action="${options.action}">
${csrfInput(options.csrf)}
${options.from ? html`<input type="hidden" name="from" value="${options.from}">` : null}
${options.extra ?? null}
${options.errors && options.errors.length > 0 ? errorNotice(options.errors) : null}
<p><label>Motivo <input type="text" name="reason" required maxlength="500"></label></p>
${alert("warning", REASON_WARNING)}
<p><label><input type="checkbox" name="confirm" value="yes"> Confirmo que quiero hacerlo</label></p>
<p><button type="submit"${options.variant ? html` class="btn-${options.variant}"` : null}>${options.button}</button></p>
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
    return html`<a class="btn btn-secondary" href="${basePath}?${params.toString()}">${label}</a>`;
  };
  return html`<p class="pager">${current > 1 ? link(current - 1, "← Anterior") : null}${hasNext ? link(current + 1, "Siguiente →") : null}</p>`;
}

/** Fecha y hora en UTC, tal como se guarda (soporte no depende de la zona de un consultorio). */
export function formatUtc(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Filtros como opciones tipo chip; la elegida se marca. */
function chips(options: ReadonlyArray<readonly [value: string, label: string]>, selected: string, href: (value: string) => string): SafeHtml {
  return html`<p class="chips">${options.map(
    ([value, label]) => html`<a class="chip${value === selected ? " is-selected" : ""}"${value === selected ? html` aria-current="true"` : null} href="${href(value)}">${label}</a>`,
  )}</p>`;
}

// --- Médicos --------------------------------------------------------------------------------------------------------

export const APPROVAL_LABEL = { pending: "Pendiente", approved: "Aprobada", rejected: "Rechazada" } as const;
export const STATE_LABEL = { active: "Activa", suspended: "Suspendida", read_only: "Solo lectura" } as const;
export const SITE_LABEL = { draft: "Borrador", published: "Publicado", unpublished: "Despublicado" } as const;

/** Insignias de soporte: la variante sale del mapeo común; el texto conserva el género de «solicitud» y «cuenta». */
const approvalBadge = (status: keyof typeof APPROVAL_LABEL): SafeHtml => badge(doctorApprovalBadge(status).variant, APPROVAL_LABEL[status]);
const accountBadge = (state: keyof typeof STATE_LABEL): SafeHtml => badge(doctorAccountBadge(state).variant, STATE_LABEL[state]);
const siteStatusBadge = (status: keyof typeof SITE_LABEL): SafeHtml => badge(siteBadge(status).variant, SITE_LABEL[status]);

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
    (d) => html`<tr><td><a href="/soporte/medicos/${d.id}">${d.fullName}</a></td><td>${approvalBadge(d.approvalStatus)}</td><td>${d.approvalStatus === "approved" ? accountBadge(d.accountState) : "—"}</td><td>${d.createdAt.toISOString().slice(0, 10)}</td></tr>`,
  );
  return supportPage(
    "Médicos",
    html`<h1>Médicos</h1>
${chips(FILTERS, options.estado, (value) => `/soporte/medicos?estado=${value}`)}
<form method="get" action="/soporte/medicos">
<input type="hidden" name="estado" value="${options.estado}">
<label>Buscar por nombre o correo del médico <input type="search" name="q" value="${options.q}" maxlength="100"></label>
<button type="submit">Buscar</button>
</form>
${options.doctors.length === 0
    ? emptyState({ title: "No hay médicos en este filtro" })
    : tableWrap(html`<table><thead><tr><th scope="col">Médico</th><th scope="col">Aprobación</th><th scope="col">Estado de la cuenta</th><th scope="col">Alta</th></tr></thead><tbody>${rows}</tbody></table>`)}`,
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
      buttons.push(html`<h3>Poner en solo lectura</h3><p>El médico consulta su agenda, pero no cambia nada y su micrositio no acepta reservas nuevas.</p>${actionForm({ action: action("solo-lectura"), csrf: options.csrf, button: "Poner en solo lectura", from: state, variant: "danger" })}`);
    }
    if (state !== "suspended") {
      buttons.push(html`<h3>Suspender</h3><p>El médico pierde el acceso y su micrositio no acepta reservas. Sus citas agendadas se conservan.</p>${actionForm({ action: action("suspender"), csrf: options.csrf, button: "Suspender", from: state, variant: "danger" })}`);
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
${definitionList([
  ["Aprobación", approvalBadge(doctor.approvalStatus)],
  ...(approved
    ? ([["Estado de la cuenta", html`${accountBadge(state)}${doctor.accountStateChangedAt ? html` <small>(cambio del ${formatUtc(doctor.accountStateChangedAt)})</small>` : null}`]] as const)
    : []),
  ["Correo", doctor.email],
  ["Cédula", doctor.cedulaNumber ?? "(liberada)"],
  ["Móvil de emergencias", doctor.emergencyMobile ?? "(liberado)"],
  ["Teléfono del consultorio", doctor.officePhone ?? "—"],
  ["Micrositio", site ? html`${siteStatusBadge(site.status)} <small>/c/${site.slug}</small>` : "Sin micrositio"],
  ["Citas futuras", futureAppointments],
  ["Motivo de rechazo", doctor.rejectionReason ?? "—"],
])}
<p><a href="/soporte/historial?objetivo=${doctor.id}">Ver historial de esta cuenta</a></p>
${doctor.cedulaFilePath ? html`<p><a href="${action("cedula")}" target="_blank" rel="noopener">Ver archivo de la cédula</a></p>` : html`<p>Sin archivo de cédula.</p>`}
${
  doctor.approvalStatus === "pending"
    ? html`<h3>Aprobar</h3><form method="post" action="${action("aprobar")}">${csrfInput(options.csrf)}
  <p><label><input type="checkbox" name="confirm" value="yes"> Confirmo que revisé la cédula y quiero aprobar esta cuenta</label></p>
  <button type="submit">Aprobar</button>
</form>
<h3>Rechazar</h3>${actionForm({ action: action("rechazar"), csrf: options.csrf, button: "Rechazar", variant: "danger" })}`
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
    (site) => html`<tr><td><a href="/soporte/medicos/${site.doctorId}">${site.doctorName}</a></td><td>/c/${site.slug}</td><td>${siteStatusBadge(site.status)}</td><td>${site.publishedAt ? formatUtc(site.publishedAt) : "—"}</td><td><a href="/soporte/micrositios/${site.doctorId}/enlace">Cambiar enlace</a></td></tr>`,
  );
  return supportPage(
    "Micrositios",
    html`<h1>Micrositios</h1>
<p>Publicados: ${options.list.counts.published} · Borradores: ${options.list.counts.draft} · Despublicados: ${options.list.counts.unpublished}</p>
${chips(SITE_FILTERS, options.filter, (value) => `/soporte/micrositios?estado=${value}`)}
${options.list.rows.length === 0
    ? emptyState({ title: "No hay micrositios en este filtro" })
    : tableWrap(html`<table><thead><tr><th scope="col">Médico</th><th scope="col">Enlace</th><th scope="col">Estado</th><th scope="col">Última publicación</th><th scope="col"><span class="visually-hidden">Acciones</span></th></tr></thead><tbody>${rows}</tbody></table>`)}`,
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
  const failed = mailBadge("failed");
  const rows = summary.failed.map(
    (mail) => html`<tr><td>${mail.id}</td><td>${badge(failed.variant, failed.text)}</td><td>${mail.template}</td><td>${mail.maskedTo}</td><td>${formatUtc(mail.createdAt)}</td><td>${mail.attempts}</td><td>${mail.errorCode ? (ERROR_LABEL[mail.errorCode] ?? "Otro error") : "—"}</td><td>${
      mail.retryable
        ? html`<details><summary>Reintentar o cancelar</summary>${actionForm({ action: `/soporte/correos/${mail.id}/reintentar`, csrf: options.csrf, button: "Reintentar", variant: "secondary" })}${actionForm({ action: `/soporte/correos/${mail.id}/cancelar`, csrf: options.csrf, button: "Cancelar el correo", variant: "danger" })}</details>`
        : html`Aviso gestionado por la cola`
    }</td></tr>`,
  );
  return supportPage(
    "Correos",
    html`<h1>Cola de correos</h1>
<p>En cola: ${summary.counts.queued} · Enviados: ${summary.counts.sent} · Fallidos: ${summary.counts.failed} · Cancelados: ${summary.counts.cancelled}</p>
<p>Antigüedad del pendiente más viejo: ${age}</p>
<h2>Fallidos</h2>
${summary.failed.length === 0
    ? emptyState({ title: "No hay correos fallidos" })
    : tableWrap(html`<table><thead><tr><th scope="col">Id</th><th scope="col">Estado</th><th scope="col">Tipo</th><th scope="col">Destinatario</th><th scope="col">Fecha</th><th scope="col">Intentos</th><th scope="col">Motivo</th><th scope="col"><span class="visually-hidden">Acciones</span></th></tr></thead><tbody>${rows}</tbody></table>`)}
${pager("/soporte/correos", {}, summary.page, summary.hasNext)}`,
  );
}

// --- Métricas del piloto ------------------------------------------------------------------------------------------------

const PERIOD_LABEL: Readonly<Record<string, string>> = { semana: "Última semana", "4semanas": "Últimas 4 semanas", piloto: "Todo el piloto" };

/** Veredicto con insignia: el texto de siempre, ahora también con color (nunca solo color). */
function verdict(ok: boolean | null): SafeHtml {
  if (ok === null) return badge("neutral", "sin datos");
  return ok ? badge("confirmed", "✓ se cumple") : badge("cancelled", "✗ no se cumple");
}

const valueOrNone = (value: number | null, suffix = ""): string => (value === null ? "sin datos" : `${value}${suffix}`);

export function metricsView(metrics: MetricsResult): string {
  const t = metrics.targets;
  const b = metrics.booking;
  const noSignals = metrics.urgentAbuse.patientsWithSeveralActive + metrics.urgentAbuse.accountsOverRequestLimit === 0;
  const rows: Array<[string, string, string, SafeHtml | string]> = [
    ["Finalización de reserva", valueOrNone(b.completionPercent, " %"), `más de ${t.completionPercent} %`, verdict(b.meetsCompletion)],
    ["Tiempo para reservar (promedio)", valueOrNone(b.averageSeconds, " s"), `menos de ${t.bookingSeconds} s`, verdict(b.meetsTime)],
    ["Reservas en menos de 2 minutos", valueOrNone(b.underTargetPercent, " %"), "—", "—"],
    ["Correos entregados", valueOrNone(metrics.mail.deliveredPercent, " %"), `más de ${t.deliveredPercent} %`, verdict(metrics.mail.meetsTarget)],
    ["Urgencias agendadas frente a «sin espacio»", metrics.urgent.scheduled + metrics.urgent.noSpace === 0 ? "sin datos" : `${metrics.urgent.scheduled} agendadas · ${metrics.urgent.noSpace} sin espacio`, "—", "—"],
    ["Posible abuso de urgencias (ahora)", `${metrics.urgentAbuse.patientsWithSeveralActive} pacientes con más de una urgencia vigente · ${metrics.urgentAbuse.accountsOverRequestLimit} cuentas con más de 3 solicitudes en 24 h`, "0", noSignals ? badge("confirmed", "✓ sin señales") : badge("pending", "⚠ revisar")],
    ["Uso sostenido (médicos activos en las dos últimas semanas completas)", valueOrNone(metrics.sustainedUse.percent, " %"), `al menos ${t.sustainedUsePercent} %`, verdict(metrics.sustainedUse.meetsTarget)],
  ];
  return supportPage(
    "Métricas del piloto",
    html`<h1>Métricas del piloto</h1>
${chips(Object.entries(PERIOD_LABEL), metrics.period, (value) => `/soporte/metricas?periodo=${value}`)}
<p>Periodo: ${PERIOD_LABEL[metrics.period]} (${metrics.from.toISOString().slice(0, 10)} a ${metrics.to.toISOString().slice(0, 10)}). Solo conteos y porcentajes: sin datos de pacientes.</p>
${tableWrap(html`<table><thead><tr><th scope="col">Métrica</th><th scope="col">Valor</th><th scope="col">Meta</th><th scope="col">Cumplimiento</th></tr></thead><tbody>${rows.map(([name, value, target, ok]) => html`<tr><td>${name}</td><td>${value}</td><td>${target}</td><td>${ok}</td></tr>`)}</tbody></table>`)}
<h2>Citas por médico y semana</h2>
${metrics.appointmentsPerDoctorWeek.length === 0 ? emptyState({ title: "sin datos" }) : tableWrap(html`<table><thead><tr><th scope="col">Semana (lunes)</th><th scope="col">Médico</th><th scope="col">Citas</th></tr></thead><tbody>${metrics.appointmentsPerDoctorWeek.map((row) => html`<tr><td>${row.week}</td><td>${row.doctorName}</td><td>${row.count}</td></tr>`)}</tbody></table>`)}
<h2>Médicos activos por semana</h2>
${metrics.activeDoctorsPerWeek.length === 0 ? emptyState({ title: "sin datos" }) : tableWrap(html`<table><thead><tr><th scope="col">Semana (lunes)</th><th scope="col">Médicos activos</th></tr></thead><tbody>${metrics.activeDoctorsPerWeek.map((row) => html`<tr><td>${row.week}</td><td>${row.count}</td></tr>`)}</tbody></table>`)}`,
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
${data.rows.length === 0
    ? emptyState({ title: "No hay acciones con estos filtros" })
    : tableWrap(html`<table><thead><tr><th scope="col">Fecha</th><th scope="col">Persona</th><th scope="col">Acción</th><th scope="col">Objetivo</th><th scope="col">Motivo</th></tr></thead><tbody>${rows}</tbody></table>`)}
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
${alert("warning", "Al liberar la cédula y el móvil de emergencias, la cuenta queda rechazada: el médico pierde el acceso a sus funciones y su micrositio deja de aceptar reservas hasta que registre otra cédula y se apruebe de nuevo. Se le avisa con un texto fijo.")}
${definitionList([
  ["Cuenta", approvalBadge(doctor.approvalStatus)],
  ["Micrositio", site ? html`${siteStatusBadge(site.status)} <small>/c/${site.slug}</small>` : "Sin micrositio"],
  ["Citas futuras", futureAppointments],
])}
<p>Las citas agendadas se conservan; sus pacientes pueden cancelarlas.</p>
${actionForm({ action: `/soporte/medicos/${doctor.id}/liberar-cedula`, csrf: options.csrf, button: "Liberar cédula y móvil", variant: "danger" })}`,
  );
}
