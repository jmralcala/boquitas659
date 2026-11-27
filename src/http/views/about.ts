import { html } from "../../lib/html.js";
import { icon } from "./icons.js";
import { publicDocument } from "./public-site.js";

/**
 * «Nosotros» (feature 8). El texto sobre Innvend Works se basa solo en lo que su propio sitio afirma (leído el
 * 27/11/2026); no se publican datos que ese sitio no muestre (dirección, redes sociales, nombres de personas).
 */

const TITLE = "Nosotros | Agenda Dental";
const DESCRIPTION = "Agenda Dental es un producto desarrollado por Innvend Works, empresa de software, datos e inteligencia artificial para empresas.";

const SITE_URL = "https://www.innvend.com";
const CONTACT_EMAIL = "contacto@innvend.com";
const CONTACT_PHONE_TEXT = "(52) 33 1241 5547";
const CONTACT_PHONE_TEL = "+523312415547";

export function aboutPage(options: { year: number; contactEmail: string }): string {
  const main = html`<section class="page-hero landing-section">
<p class="hero__tag">Quiénes somos</p>
<h1>Nosotros</h1>
<p class="hero__lead">Agenda Dental es un producto desarrollado por <strong>Innvend Works</strong>. Conoce a la empresa en <a href="${SITE_URL}" target="_blank" rel="noopener noreferrer">www.innvend.com</a>.</p>
</section>
<section class="info-section info-section--surface">
<div class="landing-section about">
<h2>Innvend Works</h2>
<p>Software, datos e IA para empresas. Innvend ayuda a las empresas a operar mejor mediante software, datos e inteligencia artificial. Combina consultoría, desarrollo de software a medida y productos propios, y tiene más de 20 años de experiencia, según su sitio.</p>
</div>
</section>
<section class="info-section">
<div class="landing-section about">
<h2>Contacto de Innvend Works</h2>
<ul class="contact-list">
<li>${icon("mail")}<span>Correo: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></span></li>
<li>${icon("phone")}<span>Teléfono: <a href="tel:${CONTACT_PHONE_TEL}">${CONTACT_PHONE_TEXT}</a></span></li>
</ul>
<p class="about__note">Este es el contacto de la empresa que desarrolla Agenda Dental; el enlace «Contacto» del pie es el de Agenda Dental.</p>
</div>
</section>`;
  return publicDocument({ current: "nosotros", title: TITLE, description: DESCRIPTION, main, year: options.year, contactEmail: options.contactEmail });
}
