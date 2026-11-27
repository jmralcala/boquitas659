import { html } from "../../lib/html.js";
import { icon, type IconName } from "./icons.js";
import { LOGIN_PATH, publicDocument, REGISTER_PATH } from "./public-site.js";

/**
 * «Cómo funciona» (feature 8). Textos literales de `specs/008-paginas-informativas-publicas/contracts/page-content.md`;
 * solo afirman capacidades que el piloto tiene (una prueba unitaria rechaza los términos prohibidos).
 */

const TITLE = "Cómo funciona Agenda Dental";
const DESCRIPTION = "Qué es Agenda Dental, sus beneficios y cómo funciona: tu micrositio propio para gestionar las citas de tu consultorio dental.";

const BENEFITS: ReadonlyArray<readonly [IconName, string, string]> = [
  ["calendar", "Una agenda ordenada", "Tú defines los horarios, la duración de cada cita, la pausa entre citas, los bloqueos y con cuántos días de anticipación pueden reservar tus pacientes."],
  ["success", "Sin dobles reservas", "Tus pacientes solo ven y reservan espacios libres: un paciente por espacio."],
  ["users", "Menos llamadas", "Tus pacientes reservan y cancelan sus citas en línea desde el celular, sin llamar al consultorio."],
  ["bell", "Menos inasistencias", "Cada cita genera un correo de confirmación y un recordatorio, con un enlace para verla o cancelarla."],
  ["globe", "Tu propio micrositio", "Una página con el nombre, la ubicación (con enlace «Cómo llegar»), el teléfono y el logo de tu consultorio, y un enlace propio para compartir."],
  ["shield", "Orden y privacidad", "Los datos de tu consultorio y de tus pacientes están separados de los de otros consultorios, y cada paciente acepta el aviso de privacidad con su consentimiento expreso."],
];

const FEATURES: readonly string[] = [
  "Micrositio con enlace propio (/c/ y el nombre que elijas).",
  "Calendario por día y por semana.",
  "Horarios, duración de cita, pausa y bloqueos configurables.",
  "Anticipación mínima y máxima de reserva, definida por ti.",
  "Cancelación del paciente hasta 24 horas antes (configurable) y cancelación del médico con aviso al paciente por correo.",
  "Correos de confirmación y de recordatorio de cada cita.",
  "Cuentas para tu personal de recepción.",
  "Datos separados por consultorio.",
  "Revisión de cada solicitud de médico por nuestro equipo antes de activar la cuenta.",
];

const DOCTOR_STEPS: readonly string[] = [
  "Te registras y nuestro equipo valida tu cédula profesional en el Registro Nacional de Profesionistas y tu identificación oficial.",
  "Configuras tu calendario y creas tu micrositio.",
  "Compartes tu enlace con tus pacientes.",
  "Tus pacientes reservan y reciben avisos por correo.",
  "Gestionas y das seguimiento a tus citas desde tu agenda.",
];

const PATIENT_STEPS: readonly string[] = [
  "Entra al enlace de su consultorio.",
  "Elige el día y el horario.",
  "Recibe la confirmación por correo.",
  "Puede cancelar su cita desde el enlace, dentro del plazo.",
];

export function howItWorksPage(options: { year: number; contactEmail: string }): string {
  const main = html`<section class="page-hero landing-section">
<p class="hero__tag">Qué es</p>
<h1>Cómo funciona Agenda Dental</h1>
<p class="hero__lead">Agenda Dental es una solución diseñada y pensada especialmente para la comunidad de odontólogos en México. Mediante una suscripción, cada médico tiene su propio micrositio para llevar la gestión y el seguimiento de sus citas.</p>
</section>
<section class="info-section info-section--surface">
<div class="landing-section">
<h2>Beneficios para tu consultorio</h2>
<ul class="info-cards">${BENEFITS.map(([name, title, text]) => html`<li class="info-card"><span class="feature__icon">${icon(name)}</span><h3>${title}</h3><p>${text}</p></li>`)}</ul>
</div>
</section>
<section class="info-section">
<div class="landing-section">
<h2>Lo que incluye</h2>
<ul class="checklist">${FEATURES.map((text) => html`<li>${icon("check")}<span>${text}</span></li>`)}</ul>
</div>
</section>
<section class="info-section info-section--surface">
<div class="landing-section steps-grid">
<div>
<h2>Para el médico</h2>
<ol class="steps">${DOCTOR_STEPS.map((text) => html`<li>${text}</li>`)}</ol>
</div>
<div>
<h2>Para el paciente</h2>
<ol class="steps">${PATIENT_STEPS.map((text) => html`<li>${text}</li>`)}</ol>
</div>
</div>
</section>
<section class="cta-band">
<div>
<h2>Empieza con tu consultorio</h2>
<p>Crea la cuenta de tu consultorio. Revisamos cada solicitud antes de activar la cuenta.</p>
</div>
<div class="cta-band__actions">
<a class="btn btn-light" href="${REGISTER_PATH}">Regístrate aquí${icon("arrow-right")}</a>
<a class="btn btn-light" href="${LOGIN_PATH}">Iniciar sesión</a>
</div>
</section>`;
  return publicDocument({ current: "como-funciona", title: TITLE, description: DESCRIPTION, main, year: options.year, contactEmail: options.contactEmail });
}
