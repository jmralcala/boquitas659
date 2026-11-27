import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Services } from "../../compose.js";
import { NotFoundError } from "../../http/errors.js";
import { parseInput } from "../../http/validate.js";
import { requireAuth } from "../../http/session-plugin.js";
import { errorList, form, submitButton } from "../../http/views/forms.js";
import { page } from "../../http/views/layout.js";
import { html, type SafeHtml } from "../../lib/html.js";
import { HOME_BY_ROLE } from "../auth/routes.js";
import { LEGAL_TYPES, isLegalType, type LegalDocument } from "./legal-service.js";

const versionParams = z.object({
  version: z.coerce.number({ error: "Versión inválida." }).int("Versión inválida.").positive("Versión inválida."),
});

function send(reply: FastifyReply, status: number, title: string, content: SafeHtml): FastifyReply {
  return reply.code(status).type("text/html; charset=utf-8").send(page({ title, content }));
}

/** El cuerpo de un documento se muestra como texto: párrafos separados por líneas en blanco, siempre escapados. */
function paragraphs(body: string): SafeHtml {
  return html`${body
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => html`<p>${block}</p>`)}`;
}

function documentView(document: LegalDocument): SafeHtml {
  return html`<h1>${document.title}</h1>
<p>Versión ${document.version} · publicada el ${document.publishedAt.toISOString().slice(0, 10)}</p>
${document.isProvisional ? html`<p role="note"><strong>Este texto es provisional y todavía no ha sido revisado por un abogado.</strong></p>` : null}
${paragraphs(document.body)}
<p><a href="/legal">Ver todos los documentos</a></p>`;
}

export function registerLegalRoutes(app: FastifyInstance, services: Services): void {
  const { legal } = services;

  app.get("/legal", async (_request, reply) => {
    const items: SafeHtml[] = [];
    for (const type of LEGAL_TYPES) {
      const latest = await legal.latest(type);
      if (latest) {
        items.push(html`<li><a href="/legal/${type}">${latest.title}</a> (versión ${latest.version})</li>`);
      }
    }
    return send(
      reply,
      200,
      "Avisos y términos",
      html`<h1>Avisos de privacidad y términos</h1>${items.length > 0 ? html`<ul>${items}</ul>` : html`<p>Todavía no hay documentos publicados.</p>`}<p><a href="/derechos">Cómo ejercer tus derechos sobre tus datos</a></p>`,
    );
  });

  app.get("/legal/aceptar", async (request, reply) => renderAccept(request, reply, 200));

  async function renderAccept(request: FastifyRequest, reply: FastifyReply, status: number, error?: string): Promise<FastifyReply> {
    const auth = requireAuth(request);
    const pending = await legal.pendingFor(auth.userId, auth.role);
    if (pending.length === 0) return reply.redirect(HOME_BY_ROLE[auth.role], 303);

    const boxes = pending.map(
      (document) => html`<p><label><input type="checkbox" name="accept_${document.id}" value="yes">
  He leído y acepto <a href="/legal/${document.type}" target="_blank" rel="noopener">${document.title}</a> (versión ${document.version})</label></p>`,
    );
    return send(
      reply,
      status,
      "Aceptar avisos",
      html`<h1>Actualizamos nuestros avisos</h1>
<p>Para seguir usando el servicio debes aceptar la versión vigente de estos documentos.</p>
${errorList(error ? [error] : undefined)}
${form({ action: "/legal/aceptar", csrf: app.csrf.tokenFor(request, reply), children: [...boxes, submitButton("Aceptar y continuar")] })}`,
    );
  }

  app.post("/legal/aceptar", async (request, reply) => {
    const auth = requireAuth(request);
    const pending = await legal.pendingFor(auth.userId, auth.role);
    if (pending.length === 0) return reply.redirect(HOME_BY_ROLE[auth.role], 303);

    // Solo cuentan los documentos que de verdad están pendientes para este rol; cualquier otro campo se ignora.
    const body = (request.body ?? {}) as Record<string, unknown>;
    const missing = pending.filter((document) => body[`accept_${document.id}`] !== "yes");
    if (missing.length > 0) {
      return renderAccept(request, reply, 400, "Debes aceptar todos los avisos para continuar: marca la casilla de cada documento.");
    }
    for (const document of pending) {
      await legal.recordAcceptance({ userId: auth.userId, documentId: document.id });
    }
    return reply.redirect(HOME_BY_ROLE[auth.role], 303);
  });

  app.get("/legal/:type", async (request, reply) => {
    const { type } = request.params as { type: string };
    if (!isLegalType(type)) throw new NotFoundError();
    const document = await legal.latest(type);
    if (!document) throw new NotFoundError();
    return send(reply, 200, document.title, documentView(document));
  });

  app.get("/legal/:type/v/:version", async (request, reply) => {
    const { type } = request.params as { type: string };
    const { version } = parseInput(versionParams, request.params);
    if (!isLegalType(type)) throw new NotFoundError();
    const document = await legal.get(type, version);
    if (!document) throw new NotFoundError();
    return send(reply, 200, document.title, documentView(document));
  });

  app.get("/derechos", async (_request, reply) => {
    const { RIGHTS_CONTACT_EMAIL: email, RIGHTS_RESPONSE_DAYS: days, RIGHTS_EXECUTION_DAYS: executionDays } = services.env;
    return send(
      reply,
      200,
      "Tus derechos sobre tus datos",
      html`<h1>Tus derechos sobre tus datos</h1>
<h2>Derechos ARCO, revocación y limitación del tratamiento</h2>
<p>Como titular de datos personales (o representante legal de un menor registrado), usted tiene derecho a conocer qué datos recabamos y las condiciones de su uso (<strong>Acceso</strong>); solicitar la corrección de su información en caso de estar desactualizada, ser inexacta o incompleta (<strong>Rectificación</strong>); pedir que sea eliminada de nuestras bases de datos cuando considere que no está siendo utilizada conforme a los principios legales aplicables (<strong>Cancelación</strong>); y oponerse al tratamiento de sus datos para finalidades específicas (<strong>Oposición</strong>).</p>
<p>Asimismo, tiene derecho a <strong>revocar el consentimiento</strong> que nos haya otorgado previamente para el tratamiento de su información y a <strong>limitar el uso o divulgación</strong> de sus datos personales.</p>
<h3>Requisitos para la solicitud</h3>
<p>Para tramitar el ejercicio de cualquiera de estos derechos, envíe un correo electrónico a la cuenta oficial de contacto: <a href="mailto:${email}">${email}</a>, adjuntando:</p>
<ol>
<li>Nombre completo del titular y dirección de correo electrónico vinculada a la cuenta de la plataforma.</li>
<li>Copia de una identificación oficial vigente (en caso de actuar en representación de un menor o tercero, deberá acompañar copia del documento que acredite la patria potestad o representación legal).</li>
<li>Descripción clara y precisa del derecho que desea ejercer (Acceso, Rectificación, Cancelación, Oposición, Revocación o Limitación) y los datos personales sobre los cuales recae la solicitud.</li>
<li>En caso de solicitar rectificación, indicar las modificaciones precisas a realizar y adjuntar la documentación que justifique la corrección.</li>
</ol>
<h3>Plazos de respuesta</h3>
<p>Recibida su solicitud completa, le responderemos en un plazo máximo de <strong>${days} días hábiles</strong> a través del correo electrónico registrado, informándole la determinación adoptada y, en su caso, haciéndola efectiva dentro de los <strong>${executionDays} días hábiles</strong> siguientes a la notificación.</p>
<p><a href="/legal">Ver los avisos de privacidad</a></p>`,
    );
  });
}
