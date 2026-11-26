import { html, type SafeHtml } from "../../lib/html.js";
import { icon, type IconName } from "./icons.js";

/** Componentes pequeños del sistema visual (contracts/assets-and-components.md). Todos devuelven HTML ya escapado. */

export type BadgeVariant = "confirmed" | "in-progress" | "pending" | "cancelled" | "neutral";
export type AlertVariant = "info" | "success" | "warning" | "error";

export interface BadgeSpec {
  variant: BadgeVariant;
  text: string;
}

/** Insignia de estado: punto de color más texto (el estado nunca se transmite solo con color). */
export function badge(variant: BadgeVariant, text: string): SafeHtml {
  return html`<span class="badge badge--${variant}"><span class="badge__dot" aria-hidden="true"></span>${text}</span>`;
}

export function badgeOf(spec: BadgeSpec): SafeHtml {
  return badge(spec.variant, spec.text);
}

const ALERT_ICON: Readonly<Record<AlertVariant, IconName>> = { info: "info", success: "success", warning: "warning", error: "error" };

/** Aviso con ícono. `prominent` lo hace el elemento más destacado de la pantalla (instrucciones de seguridad). */
export function alert(variant: AlertVariant, content: SafeHtml | string, options: { prominent?: boolean } = {}): SafeHtml {
  const role = variant === "error" || variant === "warning" ? "alert" : "status";
  return html`<div class="alert alert--${variant}${options.prominent ? " alert--prominent" : ""}" role="${role}">${icon(ALERT_ICON[variant])}<div class="alert__body">${content}</div></div>`;
}

/** Tarjeta con título (`h2`) y acciones opcionales a la derecha de la cabecera. */
export function card(title: string, content: SafeHtml | null, actions?: SafeHtml | null): SafeHtml {
  return html`<section class="card"><header class="card__header"><h2>${title}</h2>${actions ?? null}</header>${content}</section>`;
}

/** Envuelve una tabla para que se desplace dentro de su caja y la página nunca desborde (FR-008). */
export function tableWrap(table: SafeHtml): SafeHtml {
  return html`<div class="table-wrap">${table}</div>`;
}

/** Estado vacío: mensaje claro y, si hoy existe, la acción relacionada. No crea acciones nuevas. */
export function emptyState(options: { title: string; text?: string; action?: SafeHtml | null }): SafeHtml {
  return html`<div class="empty">${icon("inbox")}<p class="empty__title">${options.title}</p>${options.text ? html`<p class="empty__text">${options.text}</p>` : null}${options.action ?? null}</div>`;
}

/** Lista de pares etiqueta-valor (detalle de una cita, de un médico). */
export function definitionList(rows: ReadonlyArray<readonly [label: string, value: SafeHtml | string | number | null]>): SafeHtml {
  return html`<dl class="pairs">${rows.map(([label, value]) => html`<div><dt>${label}</dt><dd>${value}</dd></div>`)}</dl>`;
}

// --- Mapeo de estados existentes a insignias (FR-009, data-model.md §3) ---------------------------------------------

export function appointmentBadge(status: "booked" | "cancelled"): BadgeSpec {
  return status === "booked" ? { variant: "confirmed", text: "Agendada" } : { variant: "cancelled", text: "Cancelada" };
}

export function doctorApprovalBadge(status: "pending" | "approved" | "rejected"): BadgeSpec {
  if (status === "approved") return { variant: "confirmed", text: "Aprobado" };
  if (status === "pending") return { variant: "pending", text: "Pendiente" };
  return { variant: "cancelled", text: "Rechazado" };
}

export function doctorAccountBadge(state: "active" | "suspended" | "read_only"): BadgeSpec {
  if (state === "active") return { variant: "confirmed", text: "Activa" };
  if (state === "read_only") return { variant: "in-progress", text: "Solo lectura" };
  return { variant: "cancelled", text: "Suspendida" };
}

export function siteBadge(status: "draft" | "published" | "unpublished"): BadgeSpec {
  if (status === "published") return { variant: "confirmed", text: "Publicado" };
  if (status === "draft") return { variant: "pending", text: "Borrador" };
  return { variant: "neutral", text: "Despublicado" };
}

export function mailBadge(status: "pending" | "sent" | "failed" | "cancelled"): BadgeSpec {
  if (status === "sent") return { variant: "confirmed", text: "Enviado" };
  if (status === "pending") return { variant: "pending", text: "Pendiente" };
  if (status === "failed") return { variant: "cancelled", text: "Fallido" };
  return { variant: "neutral", text: "Cancelado" };
}

/** `true` cumple la meta, `false` no la cumple, `null` aún no hay datos. */
export function metricBadge(meets: boolean | null): BadgeSpec {
  if (meets === null) return { variant: "neutral", text: "Sin datos" };
  return meets ? { variant: "confirmed", text: "Cumple" } : { variant: "cancelled", text: "No cumple" };
}
