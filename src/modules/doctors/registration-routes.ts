import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Services } from "../../compose.js";
import { ValidationError } from "../../http/errors.js";
import { setSessionCookie } from "../../http/session-plugin.js";
import { checkbox, errorList, fileInput, form, passwordInput, submitButton, textInput } from "../../http/views/forms.js";
import { page } from "../../http/views/layout.js";
import { html } from "../../lib/html.js";

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
  const token = app.csrf.tokenFor(request, reply);
  const values = options.values ?? {};
  const errors = options.errors ?? {};
  return page({
    title: "Registro de médicos",
    content: html`<h1>Registro de médicos</h1>
<p>Tu cuenta quedará en revisión hasta que soporte valide tu cédula profesional.</p>
${errorList(errors._)}
${form({
  action: "/medicos/registro",
  csrf: token,
  multipart: true,
  children: [
    textInput({ name: "fullName", label: "Nombre completo", value: text(values, "fullName"), autocomplete: "name", required: true, errors: errors.fullName }),
    textInput({ name: "email", label: "Correo", type: "email", value: text(values, "email"), autocomplete: "username", required: true, errors: errors.email }),
    passwordInput({ name: "password", label: "Contraseña (mínimo 10 caracteres)", autocomplete: "new-password", required: true, errors: errors.password }),
    textInput({ name: "cedulaNumber", label: "Cédula profesional", value: text(values, "cedulaNumber"), required: true, errors: errors.cedulaNumber }),
    textInput({ name: "emergencyMobile", label: "Móvil de emergencias (10 dígitos)", type: "tel", value: text(values, "emergencyMobile"), required: true, errors: errors.emergencyMobile }),
    textInput({ name: "officePhone", label: "Teléfono del consultorio (opcional)", type: "tel", value: text(values, "officePhone"), errors: errors.officePhone }),
    checkbox({
      name: "acceptTerms",
      label: html`He leído y acepto los <a href="/legal/terms_doctor" target="_blank" rel="noopener">Términos y Condiciones del Servicio para Médicos</a>, reconociendo y aceptando que la plataforma opera exclusivamente como una herramienta tecnológica de gestión de agenda y no presta servicios médicos ni odontológicos.`,
      errors: errors.acceptTerms,
    }),
    checkbox({
      name: "acceptPrivacy",
      label: html`He leído y acepto el <a href="/legal/doctor_privacy" target="_blank" rel="noopener">Aviso de Privacidad para Médicos</a> y autorizo la validación de mi cédula profesional, acreditación académica e información de consultorio por parte del equipo de soporte.`,
      errors: errors.acceptPrivacy,
    }),
    fileInput({ name: "cedulaFile", label: "Foto o PDF de tu cédula (máximo 5 MB)", accept: "image/jpeg,image/png,application/pdf", errors: errors.cedulaFile }),
    submitButton("Enviar solicitud"),
  ],
})}
<p><a href="/login">¿Ya tienes cuenta? Inicia sesión</a></p>`,
  });
}

export function registerDoctorRegistrationRoutes(app: FastifyInstance, services: Services): void {
  app.get("/medicos/registro", async (request, reply) => {
    return reply.type("text/html; charset=utf-8").send(renderRegistration(app, request, reply));
  });

  app.post(
    "/medicos/registro",
    { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      try {
        const { userId } = await services.doctors.register(body);
        // El médico queda con sesión iniciada para ver el estado de su solicitud.
        if (request.sessionToken) await services.sessions.revoke(request.sessionToken);
        const { token } = await services.sessions.create(userId);
        setSessionCookie(reply, token);
        return reply.redirect("/medicos/estado", 303);
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
}
