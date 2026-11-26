import { html } from "../../lib/html.js";
import { icon, logo, type IconName } from "./icons.js";
import { documentHead } from "./layout.js";

/**
 * Portada pública de la raíz del sitio (feature 7). No usa `page()` ni la estructura con barra lateral: tiene su propia
 * cabecera, secciones de ancho completo y pie, y por eso NO emite las marcas del shell. Los textos son los de
 * `specs/007-pagina-de-inicio-publica/contracts/page-content.md` y solo afirman lo que el piloto ofrece (una prueba
 * unitaria rechaza cualquier término de la lista de prohibidos).
 */

const REGISTER = "/medicos/registro";
const LOGIN = "/login";

const TITLE = "Agenda Dental: agenda en línea para consultorios dentales";
const DESCRIPTION =
  "Agenda en línea para consultorios dentales: tus pacientes reservan y cancelan sus citas desde el celular y tú ves toda tu agenda en un solo lugar.";

const FEATURES: ReadonlyArray<readonly [IconName, string]> = [
  ["calendar", "Planear con certeza tu semana, con los horarios, la duración de cita y los bloqueos que tú eliges."],
  ["success", "Aprovechar al máximo cada consulta: tus pacientes solo reservan espacios libres, sin dobles reservas."],
  ["timer", "Cumplir los tiempos de cada consulta con la duración y la pausa que tú configuras."],
  ["bell", "Reducir las inasistencias con recordatorios por correo."],
  ["shield", "Mantener tu agenda y los datos de tus pacientes separados de los de otros consultorios."],
];

export function landingPage(options: { year: number; contactEmail: string }): string {
  const content = html`<a class="skip-link" href="#contenido">Saltar al contenido</a>
<header class="topbar">
<div class="topbar__inner">
<a class="brand" href="/"><span class="brand__logo">${logo()}</span><span class="brand__name">Agenda Dental</span></a>
<nav aria-label="Principal">
<a href="${REGISTER}">Registrarme</a>
<a class="btn btn-secondary" href="${LOGIN}">${icon("log-in")}Iniciar sesión</a>
</nav>
</div>
</header>
<main id="contenido">
<section class="hero landing-section">
<p class="hero__tag">Agenda en línea para consultorios dentales</p>
<h1>Tu consultorio, en orden. <span class="hero__accent">Tus pacientes, a un mensaje de distancia.</span></h1>
<p class="hero__lead">Tus pacientes prefieren agendar como hacen todo lo demás: desde su celular, en segundos y sin llamadas. <strong>Agenda Dental</strong> les permite reservar y cancelar sus citas en línea y recibir avisos por correo, mientras tú tienes toda tu agenda bajo control.</p>
<div class="hero__actions">
<a class="btn" href="${REGISTER}">Regístrate aquí${icon("arrow-right")}</a>
<a class="btn btn-secondary" href="${LOGIN}">Ya tengo cuenta</a>
</div>
</section>
<section class="benefits">
<div class="landing-section">
<h2>La agenda es el punto de partida de un consultorio que funciona bien.</h2>
<p class="benefits__intro">Con ella bien gestionada puedes:</p>
<ul class="features">${FEATURES.map(([name, text]) => html`<li class="feature"><span class="feature__icon">${icon(name)}</span><p>${text}</p></li>`)}</ul>
</div>
</section>
<section class="cta-band">
<div>
<h2>Menos llamadas y una agenda más ordenada.</h2>
<p>Crea la cuenta de tu consultorio y empieza a recibir citas en línea. Revisamos cada solicitud antes de activar la cuenta.</p>
</div>
<a class="btn btn-light" href="${REGISTER}">Regístrate aquí${icon("arrow-right")}</a>
</section>
</main>
<footer class="landing-footer">
<div class="landing-footer__inner">
<p>© ${options.year} Agenda Dental</p>
<nav aria-label="Información">
<a href="/legal/doctor_privacy">Aviso de privacidad</a>
<a href="/legal/terms_doctor">Términos y condiciones</a>
<a href="mailto:${options.contactEmail}" title="Escribir a ${options.contactEmail}">Contacto</a>
</nav>
</div>
</footer>`;
  return `<!doctype html>
<html lang="es">
${documentHead({ title: TITLE, description: DESCRIPTION })}
<body class="landing">
${content.toString()}
</body>
</html>`;
}

