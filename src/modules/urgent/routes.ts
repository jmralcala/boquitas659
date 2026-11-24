import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Services } from "../../compose.js";
import { ConflictError, SiteUnavailableError, ValidationError } from "../../http/errors.js";
import { wantsJson } from "../../http/negotiation.js";
import { isFullyAuthenticated } from "../../http/session-plugin.js";
import { alarmPage, callOfficePage, captchaUnavailablePage, noSpacePage, urgentFormPage, urgentUnavailablePage } from "../../http/views/urgent.js";
import type { TenantContext } from "../../lib/tenant.js";
import { findAccountByUserId, listPatientsByAccount } from "../patients/patient-repository.js";
import { hasActiveAuthorization } from "../site/authorization.js";
import type { PublishedSite } from "../site/site-resolver.js";
import { MAX_CAPTCHA_TOKEN_LENGTH } from "./captcha.js";
import { withTurnstileCsp } from "./csp.js";
import { findEmergencyContact } from "./emergency-contact.js";
import { TRIAGE_CONTENT, categoryById, parseAlarmSignals, parseCategory, urgentContentAvailable } from "./triage-content.js";
import { requestUrgent } from "./urgent-service.js";

/** Pantallas del formulario: 120 por minuto por IP. Solicitudes: 10 por hora por IP (además de los límites por cuenta). */
const READ_RATE_LIMIT = { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } } as const;
const POST_RATE_LIMIT = { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } } as const;

const bodySchema = z.object({
  patientId: z.coerce.number({ error: "Elige para quién es la cita." }).int("Elige para quién es la cita.").positive("Elige para quién es la cita."),
  autorizo: z.string().optional(),
  "cf-turnstile-response": z.string().optional(),
});

interface Resolved {
  ctx: TenantContext;
  site: PublishedSite;
  userId: number;
}

/**
 * Rutas de la urgencia del paciente (contracts/http-routes.md). La categoría y las señales de alarma NUNCA se guardan,
 * ni se registran, ni se devuelven en una respuesta, una URL o una cookie: solo se usan para esta petición.
 */
export function registerUrgentRoutes(app: FastifyInstance, services: Services): void {
  /** Responde la pantalla «confirma por teléfono» (403) cuando el consultorio no acepta reservas en línea. */
  async function sendUnavailable(reply: FastifyReply, slug: string): Promise<FastifyReply> {
    const view = await services.site.resolveSite(slug);
    const notice = view.kind === "unavailable" ? { doctorName: view.doctorName, officePhone: view.officePhone } : { doctorName: "", officePhone: null };
    return reply.code(403).type("text/html; charset=utf-8").send(urgentUnavailablePage(notice));
  }

  /** El contexto de paciente del consultorio del enlace, o `null` si ya respondió que no acepta reservas en línea. */
  async function resolve(request: FastifyRequest, reply: FastifyReply, slug: string): Promise<Resolved | null> {
    try {
      const resolved = await services.site.resolvePatientSite(request.auth, slug);
      return { ctx: resolved.ctx, site: resolved.site, userId: resolved.auth.userId };
    } catch (error) {
      if (error instanceof SiteUnavailableError) {
        await sendUnavailable(reply, slug);
        return null;
      }
      throw error;
    }
  }

  /** ¿Se ofrece la urgencia en línea? En producción exige contenido validado por un dentista y un CAPTCHA configurado. */
  function offered(): boolean {
    return urgentContentAvailable(services.env.APP_ENV) && services.captchaConfigured;
  }

  function widgetCsp(reply: FastifyReply): void {
    if (services.captchaSiteKey === null) return;
    void reply.header("content-security-policy", withTurnstileCsp(String(reply.getHeader("content-security-policy") ?? "")));
  }

  async function formData(resolved: Resolved) {
    const account = await findAccountByUserId(services.db, resolved.userId);
    const patients = account ? await listPatientsByAccount(services.db, account.id) : [];
    const needsAuthorization = account ? !(await hasActiveAuthorization(resolved.ctx, services.db, account.id)) : true;
    return { patients: patients.map((patient) => ({ id: patient.id, name: patient.fullName })), needsAuthorization };
  }

  app.get("/c/:slug/urgencia", READ_RATE_LIMIT, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    if (!isFullyAuthenticated(request.auth)) return reply.redirect(`/c/${slug}`, 303);
    const resolved = await resolve(request, reply, slug);
    if (!resolved) return reply;
    if (!offered()) {
      return reply.type("text/html; charset=utf-8").send(callOfficePage({ doctorName: resolved.site.doctorName, contact: await findEmergencyContact(resolved.ctx, services.db) }));
    }
    const data = await formData(resolved);
    if (wantsJson(request)) {
      return reply.send({
        version: TRIAGE_CONTENT.version,
        categories: TRIAGE_CONTENT.categories.map((category) => ({ id: category.id, label: category.label, optionText: category.optionText })),
        alarmSignals: TRIAGE_CONTENT.alarmSignals,
        patients: data.patients,
        needsAuthorization: data.needsAuthorization,
      });
    }
    widgetCsp(reply);
    return reply
      .type("text/html; charset=utf-8")
      .send(urgentFormPage({ slug: resolved.site.slug, doctorName: resolved.site.doctorName, csrf: app.csrf.tokenFor(request, reply), ...data, selectedPatientId: null, siteKey: services.captchaSiteKey, errors: {} }));
  });

  app.post("/c/:slug/urgencia", POST_RATE_LIMIT, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const resolved = await resolve(request, reply, slug);
    if (!resolved) return reply;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const contact = () => findEmergencyContact(resolved.ctx, services.db);
    if (!offered()) {
      return reply.code(403).type("text/html; charset=utf-8").send(callOfficePage({ doctorName: resolved.site.doctorName, contact: await contact() }));
    }

    // El formulario vuelve SIN ninguna categoría elegida: nunca se repite el valor recibido.
    const rerender = async (status: number, errors: Readonly<Record<string, readonly string[]>>) => {
      const data = await formData(resolved);
      const selected = Number(body.patientId);
      widgetCsp(reply);
      return reply.code(status).type("text/html; charset=utf-8").send(
        urgentFormPage({
          slug: resolved.site.slug,
          doctorName: resolved.site.doctorName,
          csrf: app.csrf.tokenFor(request, reply),
          ...data,
          selectedPatientId: Number.isInteger(selected) ? selected : null,
          siteKey: services.captchaSiteKey,
          errors,
        }),
      );
    };

    // 1. Validación de la entrada con zod (los mensajes son fijos: no incluyen lo recibido).
    const category = parseCategory(body.categoria);
    const signals = parseAlarmSignals(body.senales);
    const parsed = bodySchema.safeParse(body);
    if (category === null || signals === null || !parsed.success) {
      const errors: Record<string, string[]> = {};
      if (category === null) errors.categoria = ["Elige una de las opciones."];
      if (signals === null) errors.senales = ["Las señales marcadas no son válidas."];
      if (!parsed.success) errors.patientId = ["Elige para quién es la cita."];
      return rerender(400, errors);
    }

    // 2. Señales de alarma: bloquean la solicitud ANTES del CAPTCHA y sin tocar nada (ni base, ni contadores, ni registros).
    if (signals.length > 0) {
      void reply.header("cache-control", "no-store");
      return reply.type("text/html; charset=utf-8").send(alarmPage({ doctorName: resolved.site.doctorName, contact: await contact() }));
    }

    // Con el widget activo (hay clave pública) un token ausente o desmedido no llega al proveedor: es inválido.
    const token = parsed.data["cf-turnstile-response"] ?? "";
    if (services.captchaSiteKey !== null && (token === "" || token.length > MAX_CAPTCHA_TOKEN_LENGTH)) {
      return rerender(400, { captcha: ["No pudimos verificar que eres una persona. Inténtalo de nuevo."] });
    }

    // 3. CAPTCHA: falla cerrado. Un token inválido no cuenta; si no hay verificación disponible se muestra cómo llamar.
    const verdict = await services.captcha.verify(token, request.ip);
    if (verdict === "invalid") return rerender(400, { captcha: ["No pudimos verificar que eres una persona. Inténtalo de nuevo."] });
    if (verdict === "unavailable") {
      void reply.header("cache-control", "no-store");
      return reply.type("text/html; charset=utf-8").send(captchaUnavailablePage({ slug: resolved.site.slug, doctorName: resolved.site.doctorName, contact: await contact() }));
    }

    // 4. La solicitud, bajo el bloqueo del médico.
    try {
      const result = await requestUrgent(resolved.ctx, { db: services.db, clock: services.clock }, { patientId: parsed.data.patientId, category, authorize: parsed.data.autorizo === "yes" });
      if (result.kind === "scheduled") return reply.redirect(`/pacientes/citas/${result.id}`, 303);
      void reply.header("cache-control", "no-store");
      return reply
        .type("text/html; charset=utf-8")
        .send(noSpacePage({ doctorName: resolved.site.doctorName, contact: await contact(), hospitalNotice: categoryById(category).requiresHospitalNotice }));
    } catch (error) {
      // El consultorio dejó de aceptar reservas entre la comprobación de la ruta y la transacción.
      if (error instanceof SiteUnavailableError) return sendUnavailable(reply, slug);
      if (error instanceof ValidationError) return rerender(400, error.fields ?? {});
      if (error instanceof ConflictError) return rerender(409, { _: [error.publicMessage] });
      throw error;
    }
  });
}
