import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Services } from "../../compose.js";
import { AppError, InvalidLinkError, ValidationError } from "../../http/errors.js";
import { parseInput } from "../../http/validate.js";
import { requireAuth, requireRole, setSessionCookie } from "../../http/session-plugin.js";
import { checkbox, csrfInput, errorList, form, passwordInput, submitButton, textInput } from "../../http/views/forms.js";
import { page } from "../../http/views/layout.js";
import { html, type SafeHtml } from "../../lib/html.js";
import { findDoctorById } from "../doctors/doctor-repository.js";
import { listPatientsForDoctor } from "../patients/patient-repository.js";
import { MAX_RECEPTION_PER_DOCTOR } from "./reception-repository.js";

type FieldErrors = Readonly<Record<string, readonly string[]>>;

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const idParams = z.object({ id: z.coerce.number({ error: "Id inválido." }).int("Id inválido.").positive("Id inválido.") });
const emailBody = z.object({ email: z.string().max(254).default("") });
const doctorBody = z.object({ doctorId: z.coerce.number({ error: "Elige un médico." }).int("Elige un médico.").positive("Elige un médico.") });

function text(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value.slice(0, 300) : "";
}

function send(reply: FastifyReply, status: number, title: string, content: SafeHtml): FastifyReply {
  return reply.code(status).type("text/html; charset=utf-8").send(page({ title, content }));
}

function invalidLink(reply: FastifyReply): FastifyReply {
  return send(
    reply,
    410,
    "Invitación vencida",
    html`<h1>La invitación venció</h1><p>El enlace venció, ya se usó o la invitación fue cancelada. Pide al médico que te envíe una nueva.</p>`,
  );
}

export function registerReceptionRoutes(app: FastifyInstance, services: Services): void {
  const { requireApprovedDoctor, loadDoctor } = services.doctorGuards;

  // --- Médico: administra a su personal de recepción -----------------------------------------------------------

  async function renderTeam(
    request: FastifyRequest,
    reply: FastifyReply,
    status: number,
    errors: FieldErrors = {},
    email = "",
  ): Promise<FastifyReply> {
    const doctor = await loadDoctor(request);
    const csrf = app.csrf.tokenFor(request, reply);
    const [members, pending] = await Promise.all([services.memberships.listActive(doctor.id), services.memberships.listPending(doctor.id)]);
    const memberItems = members.map(
      (m) => html`<li>${m.fullName ?? m.email} (${m.email})
  <form method="post" action="/medicos/recepcion/${m.membershipId}/retirar">${csrfInput(csrf)}<button type="submit">Retirar acceso</button></form></li>`,
    );
    const pendingItems = pending.map(
      (i) => html`<li>${i.email} — pendiente, vence el ${i.expiresAt.toISOString().slice(0, 10)}
  <form method="post" action="/medicos/recepcion/invitaciones/${i.id}/revocar">${csrfInput(csrf)}<button type="submit">Revocar invitación</button></form></li>`,
    );
    return send(
      reply,
      status,
      "Mi recepción",
      html`<h1>Mi personal de recepción</h1>
<p>Puedes tener hasta ${MAX_RECEPTION_PER_DOCTOR} personas (las invitaciones pendientes cuentan). Recepción ve tu agenda y los datos de contacto de tus pacientes, pero no cambia tu configuración, pagos, móvil de emergencias ni cédula, ni invita a otras personas.</p>
<h2>Con acceso</h2>
${members.length > 0 ? html`<ul>${memberItems}</ul>` : html`<p>Todavía no hay nadie.</p>`}
<h2>Invitaciones pendientes</h2>
${pending.length > 0 ? html`<ul>${pendingItems}</ul>` : html`<p>No hay invitaciones pendientes.</p>`}
<h2>Invitar a una persona</h2>
${errorList(errors._)}
${form({
  action: "/medicos/recepcion/invitar",
  csrf,
  children: [textInput({ name: "email", label: "Correo de la persona", type: "email", value: email, required: true, errors: errors.email }), submitButton("Enviar invitación")],
})}`,
    );
  }

  app.get("/medicos/recepcion", { preHandler: requireApprovedDoctor }, async (request, reply) => renderTeam(request, reply, 200));

  app.post(
    "/medicos/recepcion/invitar",
    { preHandler: requireApprovedDoctor, config: { rateLimit: { max: 20, timeWindow: "1 hour" } } },
    async (request, reply) => {
      const { email } = parseInput(emailBody, request.body ?? {});
      const doctor = await loadDoctor(request);
      try {
        await services.invitations.invite(doctor.id, requireAuth(request).userId, email);
        return reply.redirect("/medicos/recepcion", 303);
      } catch (error) {
        if (error instanceof ValidationError) return renderTeam(request, reply, 400, error.fields ?? {}, email);
        if (error instanceof AppError && error.code === "limit_reached") {
          return renderTeam(request, reply, 409, { _: [error.publicMessage] }, email);
        }
        throw error;
      }
    },
  );

  app.post("/medicos/recepcion/:id/retirar", { preHandler: requireApprovedDoctor }, async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    const doctor = await loadDoctor(request);
    await services.memberships.remove(doctor.id, requireAuth(request).userId, id);
    return reply.redirect("/medicos/recepcion", 303);
  });

  app.post("/medicos/recepcion/invitaciones/:id/revocar", { preHandler: requireApprovedDoctor }, async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    const doctor = await loadDoctor(request);
    await services.invitations.revoke(doctor.id, requireAuth(request).userId, id);
    return reply.redirect("/medicos/recepcion", 303);
  });

  // --- Público: aceptar una invitación (abrir el enlace nunca la consume) ---------------------------------------

  function invitationForm(
    request: FastifyRequest,
    reply: FastifyReply,
    token: string,
    summary: { doctorName: string; email: string; existingAccount: boolean },
    values: Record<string, unknown> = {},
    errors: FieldErrors = {},
  ): SafeHtml {
    return html`<h1>Invitación de recepción</h1>
<p>${summary.doctorName} te invitó a colaborar como personal de recepción con el correo ${summary.email}.</p>
${errorList(errors._)}
${form({
  action: `/recepcion/invitacion/${token}`,
  csrf: app.csrf.tokenFor(request, reply),
  children: [
    summary.existingAccount ? html`<p>Ya tienes una cuenta de recepción: solo falta que aceptes los avisos.</p>` : null,
    summary.existingAccount ? null : textInput({ name: "fullName", label: "Tu nombre completo", value: text(values, "fullName"), autocomplete: "name", required: true, errors: errors.fullName }),
    summary.existingAccount ? null : passwordInput({ name: "password", label: "Contraseña (mínimo 10 caracteres)", autocomplete: "new-password", required: true, errors: errors.password }),
    checkbox({
      name: "acceptPrivacy",
      label: html`He leído y acepto el <a href="/legal/reception_privacy" target="_blank" rel="noopener">aviso de privacidad</a>`,
      errors: errors.acceptPrivacy,
    }),
    checkbox({
      name: "acceptConfidentiality",
      label: html`Me comprometo a guardar la confidencialidad de los datos de los pacientes (<a href="/legal/reception_confidentiality" target="_blank" rel="noopener">compromiso de confidencialidad</a>)`,
      errors: errors.acceptConfidentiality,
    }),
    submitButton("Aceptar invitación"),
  ],
})}`;
  }

  app.get("/recepcion/invitacion/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    if (!TOKEN.test(token)) return invalidLink(reply);
    const summary = await services.invitations.peek(token);
    if (!summary) return invalidLink(reply);
    return send(reply, 200, "Invitación de recepción", invitationForm(request, reply, token, summary));
  });

  app.post(
    "/recepcion/invitacion/:token",
    { config: { rateLimit: { max: 20, timeWindow: "1 hour" } } },
    async (request, reply) => {
      const { token } = request.params as { token: string };
      if (!TOKEN.test(token)) return invalidLink(reply);
      const body = (request.body ?? {}) as Record<string, unknown>;
      try {
        const { userId, isNewAccount } = await services.invitations.accept(token, body);
        if (!isNewAccount) return reply.redirect("/login", 303); // cuenta existente: debe iniciar sesión con su contraseña
        if (request.sessionToken) await services.sessions.revoke(request.sessionToken);
        const session = await services.sessions.create(userId);
        setSessionCookie(reply, session.token);
        return reply.redirect("/recepcion/panel", 303);
      } catch (error) {
        if (error instanceof InvalidLinkError) return invalidLink(reply);
        if (error instanceof ValidationError) {
          const summary = await services.invitations.peek(token);
          if (!summary) return invalidLink(reply);
          return send(reply, 400, "Invitación de recepción", invitationForm(request, reply, token, summary, body, error.fields ?? {}));
        }
        throw error;
      }
    },
  );

  // --- Recepción: elegir médico y panel ------------------------------------------------------------------------

  const onlyReception = requireRole("reception");

  app.get("/recepcion/medico-activo", { preHandler: onlyReception }, async (request, reply) => {
    const auth = requireAuth(request);
    const doctors = await services.memberships.doctorsFor(auth.userId);
    const csrf = app.csrf.tokenFor(request, reply);
    const items = doctors.map(
      (d) => html`<li>${d.fullName}
  <form method="post" action="/recepcion/medico-activo">${csrfInput(csrf)}<input type="hidden" name="doctorId" value="${d.doctorId}"><button type="submit">Trabajar con este médico</button></form></li>`,
    );
    return send(
      reply,
      200,
      "Elegir médico",
      html`<h1>¿Con qué médico trabajas ahora?</h1>${doctors.length > 0 ? html`<ul>${items}</ul>` : html`<p>Todavía no tienes ningún médico vinculado.</p>`}`,
    );
  });

  app.post("/recepcion/medico-activo", { preHandler: onlyReception }, async (request, reply) => {
    const auth = requireAuth(request);
    const { doctorId } = parseInput(doctorBody, request.body ?? {});
    await services.memberships.selectActiveDoctor(auth.sessionId, auth.userId, doctorId);
    return reply.redirect("/recepcion/panel", 303);
  });

  app.get("/recepcion/panel", { preHandler: onlyReception }, async (request, reply) => {
    let auth = requireAuth(request);
    if (auth.activeDoctorId === null) {
      const doctors = await services.memberships.doctorsFor(auth.userId);
      if (doctors.length === 0) {
        return send(reply, 200, "Panel de recepción", html`<h1>Panel de recepción</h1><p>Todavía no tienes ningún médico vinculado.</p>`);
      }
      const only = doctors[0];
      if (doctors.length > 1 || !only) return reply.redirect("/recepcion/medico-activo", 303);
      // Un solo médico: se elige solo (no es una acción de la persona, no se registra).
      await services.memberships.selectActiveDoctor(auth.sessionId, auth.userId, only.doctorId, { log: false });
      auth = { ...auth, activeDoctorId: only.doctorId };
      request.auth = auth;
    }

    // El vínculo se revalida en esta misma petición antes de tocar datos del médico.
    const tenant = await services.tenants.resolve(request);
    const [doctor, patients] = await Promise.all([findDoctorById(services.db, tenant.doctorId), listPatientsForDoctor(tenant, services.db)]);
    const rows = patients.map((p) => html`<tr><td>${p.fullName}</td><td>${p.phone ?? "—"}</td><td>${p.email ?? "—"}</td></tr>`);
    return send(
      reply,
      200,
      "Panel de recepción",
      html`<h1>Panel de recepción</h1>
<p>Trabajas con ${doctor?.fullName ?? "tu médico"}. <a href="/recepcion/medico-activo">Cambiar de médico</a></p>
<h2>Pacientes (datos de contacto)</h2>
${patients.length > 0 ? html`<table><thead><tr><th>Nombre</th><th>Teléfono</th><th>Correo</th></tr></thead><tbody>${rows}</tbody></table>` : html`<p>Todavía no hay pacientes.</p>`}`,
    );
  });
}
