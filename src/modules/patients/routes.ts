import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Services } from "../../compose.js";
import { ForbiddenError, ValidationError } from "../../http/errors.js";
import { requireAuth, requireRole, setSessionCookie } from "../../http/session-plugin.js";
import { checkbox, errorList, form, passwordInput, submitButton, textInput } from "../../http/views/forms.js";
import { page } from "../../http/views/layout.js";
import { calculateAge, todayInZone } from "../../lib/age.js";
import { html } from "../../lib/html.js";
import { findAccountByUserId, listPatientsByAccount } from "./patient-repository.js";
import { OFFICE_TIME_ZONE } from "./registration-service.js";

type FieldErrors = Readonly<Record<string, readonly string[]>>;

function text(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value.slice(0, 300) : "";
}

function renderRegistration(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  options: { values?: Record<string, unknown>; errors?: FieldErrors } = {},
): string {
  const values = options.values ?? {};
  const errors = options.errors ?? {};
  return page({
    title: "Crear cuenta de paciente",
    content: html`<h1>Crear cuenta de paciente</h1>
<p>Con una sola cuenta puedes agendar con cualquier consultorio. Cada médico solo verá tus datos si agendas con él.</p>
${errorList(errors._)}
${form({
  action: "/pacientes/registro",
  csrf: app.csrf.tokenFor(request, reply),
  children: [
    textInput({ name: "fullName", label: "Nombre completo", value: text(values, "fullName"), autocomplete: "name", required: true, errors: errors.fullName }),
    textInput({ name: "birthDate", label: "Fecha de nacimiento", type: "date", value: text(values, "birthDate"), autocomplete: "bday", required: true, errors: errors.birthDate }),
    textInput({ name: "email", label: "Correo", type: "email", value: text(values, "email"), autocomplete: "username", required: true, errors: errors.email }),
    textInput({ name: "phone", label: "Teléfono (10 dígitos)", type: "tel", value: text(values, "phone"), autocomplete: "tel", required: true, errors: errors.phone }),
    passwordInput({ name: "password", label: "Contraseña (mínimo 10 caracteres)", autocomplete: "new-password", required: true, errors: errors.password }),
    checkbox({
      name: "acceptPrivacy",
      label: html`He leído y acepto el <a href="/legal/patient_privacy" target="_blank" rel="noopener">aviso de privacidad</a> y doy mi consentimiento expreso para el tratamiento de mis datos de salud`,
      errors: errors.acceptPrivacy,
    }),
    submitButton("Crear cuenta"),
  ],
})}
<p><a href="/login">¿Ya tienes cuenta? Inicia sesión</a></p>`,
  });
}

async function renderPanel(
  app: FastifyInstance,
  services: Services,
  request: FastifyRequest,
  reply: FastifyReply,
  options: { values?: Record<string, unknown>; errors?: FieldErrors } = {},
): Promise<string> {
  const auth = requireAuth(request);
  const account = await findAccountByUserId(services.db, auth.userId);
  if (!account) throw new ForbiddenError();
  const patients = await listPatientsByAccount(services.db, account.id);
  const today = todayInZone(services.clock.now(), OFFICE_TIME_ZONE);
  const values = options.values ?? {};
  const errors = options.errors ?? {};

  const items = patients.map((patient) => {
    const age = calculateAge(patient.birthDate, today);
    return html`<li>${patient.fullName} — ${age === 1 ? "1 año" : `${age} años`}${patient.isMinorDependent ? " (adicional)" : ""}</li>`;
  });

  return page({
    title: "Mi cuenta",
    content: html`<h1>Mi cuenta</h1>
<h2>Pacientes en mi cuenta</h2>
<ul>${items}</ul>
<h2>Añadir un paciente adicional (por ejemplo, un hijo)</h2>
${errorList(errors._)}
${form({
  action: "/pacientes/adicionales",
  csrf: app.csrf.tokenFor(request, reply),
  children: [
    textInput({ name: "fullName", label: "Nombre completo", value: text(values, "fullName"), required: true, errors: errors.fullName }),
    textInput({ name: "birthDate", label: "Fecha de nacimiento", type: "date", value: text(values, "birthDate"), required: true, errors: errors.birthDate }),
    textInput({ name: "phone", label: "Teléfono (opcional)", type: "tel", value: text(values, "phone"), errors: errors.phone }),
    checkbox({
      name: "acceptPrivacyOnBehalf",
      label: html`Como tutor, acepto en nombre del menor el <a href="/legal/patient_privacy" target="_blank" rel="noopener">aviso de privacidad</a> y doy mi consentimiento expreso para el tratamiento de sus datos de salud`,
      errors: errors.acceptPrivacyOnBehalf,
    }),
    submitButton("Añadir paciente"),
  ],
})}`,
  });
}

export function registerPatientRoutes(app: FastifyInstance, services: Services): void {
  app.get("/pacientes/registro", async (request, reply) => {
    return reply.type("text/html; charset=utf-8").send(renderRegistration(app, request, reply));
  });

  app.post(
    "/pacientes/registro",
    { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      try {
        const { userId } = await services.patients.register(body);
        if (request.sessionToken) await services.sessions.revoke(request.sessionToken);
        const { token } = await services.sessions.create(userId);
        setSessionCookie(reply, token);
        return reply.redirect("/pacientes/panel", 303);
      } catch (error) {
        if (error instanceof ValidationError) {
          return reply
            .code(400)
            .type("text/html; charset=utf-8")
            .send(renderRegistration(app, request, reply, { values: body, errors: error.fields ?? {} }));
        }
        throw error;
      }
    },
  );

  app.get("/pacientes/panel", { preHandler: requireRole("patient") }, async (request, reply) => {
    return reply.type("text/html; charset=utf-8").send(await renderPanel(app, services, request, reply));
  });

  app.post(
    "/pacientes/adicionales",
    { preHandler: requireRole("patient"), config: { rateLimit: { max: 30, timeWindow: "1 hour" } } },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      try {
        await services.dependents.addDependent(requireAuth(request).userId, body);
        return reply.redirect("/pacientes/panel", 303);
      } catch (error) {
        if (error instanceof ValidationError) {
          return reply
            .code(400)
            .type("text/html; charset=utf-8")
            .send(await renderPanel(app, services, request, reply, { values: body, errors: error.fields ?? {} }));
        }
        throw error;
      }
    },
  );
}
