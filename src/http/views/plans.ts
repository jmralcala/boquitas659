import { html } from "../../lib/html.js";
import { icon } from "./icons.js";
import { publicDocument, REGISTER_PATH } from "./public-site.js";

/**
 * «Planes» (feature 8). Precios y topes decididos por la persona responsable (27/11/2026) y **provisionales hasta la
 * revisión de Jurídico y Contabilidad**. El precio con descuento se calcula aquí, nunca se escribe a mano.
 */

export interface Plan {
  id: "esencial" | "profesional" | "elite";
  name: string;
  /** Pesos MXN por mes, IVA incluido. */
  priceMxn: number;
  /** Días de prueba, o `null` si el plan no tiene prueba. */
  trialDays: number | null;
  /** Tope de avisos por WhatsApp: se muestra siempre como «Próximamente» (WhatsApp no existe en el piloto). */
  whatsappAllowance: string;
}

export const PLANS: readonly Plan[] = [
  { id: "esencial", name: "Esencial", priceMxn: 499, trialDays: 5, whatsappAllowance: "30 avisos de urgencia por WhatsApp al mes" },
  { id: "profesional", name: "Profesional", priceMxn: 999, trialDays: null, whatsappAllowance: "400 mensajes de WhatsApp al mes" },
  { id: "elite", name: "Élite", priceMxn: 1999, trialDays: null, whatsappAllowance: "1,200 mensajes de WhatsApp al mes" },
];

export const DISCOUNT_PERCENT = 30;

/** Precio con descuento: el (100 − descuento) % del original, redondeado al peso más cercano (con enteros, sin coma flotante). */
export function priceWithDiscount(priceMxn: number): number {
  return Math.floor((priceMxn * (100 - DISCOUNT_PERCENT) + 50) / 100);
}

/** Pesos enteros con separador de miles: `1399` → `$1,399`. */
export function formatMxn(pesos: number): string {
  return `$${String(pesos).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

const TITLE = "Planes de Agenda Dental";
const DESCRIPTION = "Conoce los planes Esencial, Profesional y Élite de Agenda Dental, con 30 % de descuento de lanzamiento.";

const NOTES: readonly string[] = [
  "Promoción de lanzamiento por tiempo limitado. Precios y condiciones sujetos a cambio.",
  "Precios en pesos mexicanos (MXN) por mes, con IVA incluido.",
  "Hoy los avisos de Agenda Dental salen por correo. Los avisos por WhatsApp estarán disponibles próximamente.",
  "Durante el piloto no se realiza ningún cobro. El cobro se activará más adelante y se te avisará con anticipación.",
];

const COMMON = "Micrositio, agenda y reservas de tus pacientes";

export function plansPage(options: { year: number; contactEmail: string }): string {
  const cards = PLANS.map(
    (plan) => html`<li class="plan">
<h2>${plan.name}</h2>
<p><span class="tag">${DISCOUNT_PERCENT} % de descuento</span></p>
<p class="price"><del class="price__old"><span class="visually-hidden">Precio anterior: </span>${formatMxn(plan.priceMxn)}</del> <span class="price__now"><span class="visually-hidden">Precio con descuento: </span>${formatMxn(priceWithDiscount(plan.priceMxn))}</span></p>
<p class="price__unit">al mes · IVA incluido</p>
<ul class="checklist">
<li>${icon("check")}<span>${plan.trialDays === null ? "Sin prueba" : `Prueba de ${plan.trialDays} días`}</span></li>
<li>${icon("check")}<span>${COMMON}</span></li>
<li>${icon("check")}<span>Avisos por correo</span></li>
<li>${icon("check")}<span>${plan.whatsappAllowance} <span class="tag tag--soon">Próximamente</span></span></li>
</ul>
<a class="btn" href="${REGISTER_PATH}">Regístrate aquí${icon("arrow-right")}</a>
</li>`,
  );
  const main = html`<section class="page-hero landing-section">
<p class="hero__tag">Suscripción mensual</p>
<h1>Planes</h1>
<p class="hero__lead">Elige el plan para tu consultorio. Por lanzamiento, todos los planes tienen ${DISCOUNT_PERCENT} % de descuento.</p>
</section>
<section class="info-section">
<div class="landing-section">
<ul class="plans">${cards}</ul>
<ul class="notes">${NOTES.map((text) => html`<li>${text}</li>`)}</ul>
</div>
</section>`;
  return publicDocument({ current: "planes", title: TITLE, description: DESCRIPTION, main, year: options.year, contactEmail: options.contactEmail });
}
