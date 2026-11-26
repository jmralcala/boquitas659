import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Services } from "../../compose.js";
import { NotFoundError, ValidationError } from "../../http/errors.js";
import { wantsJson } from "../../http/negotiation.js";
import { isFullyAuthenticated, setSessionCookie } from "../../http/session-plugin.js";
import { directionsUrl, entryPage, firstAppointmentPage, publicSitePage, unavailableSitePage } from "../../http/views/site.js";
import { setDeviceCookie, DEVICE_COOKIE } from "../auth/devices.js";
import type { PublishedSite, SiteView } from "./site-resolver.js";

/** Límite de peticiones por IP del micrositio público (120 por minuto). */
const PUBLIC_RATE_LIMIT = { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } } as const;

/** Rutas públicas del micrositio y de la entrada del paciente (contracts/http-routes.md). */
export function registerSitePublicRoutes(app: FastifyInstance, services: Services): void {
  app.get("/c/:slug", PUBLIC_RATE_LIMIT, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const view = await services.site.resolveSite(slug);
    if (view.kind === "missing") throw new NotFoundError();
    if (view.kind === "unavailable") {
      if (wantsJson(request)) return reply.send({ kind: "unavailable", doctorName: view.doctorName, officePhone: view.officePhone });
      return reply.type("text/html; charset=utf-8").send(unavailableSitePage({ doctorName: view.doctorName, officePhone: view.officePhone }));
    }
    // Un paciente con sesión pasa directo al calendario.
    if (isFullyAuthenticated(request.auth) && request.auth.role === "patient") return reply.redirect(`/c/${view.site.slug}/reservar`, 303);

    if (wantsJson(request)) {
      return reply.send({
        kind: "published",
        slug: view.site.slug,
        doctorName: view.site.doctorName,
        address: view.site.address,
        officePhone: view.site.officePhone,
        hasLogo: view.site.logoFile !== null,
        directionsUrl: view.site.address === null ? null : directionsUrl(view.site.address),
      });
    }
    return reply.type("text/html; charset=utf-8").send(
      publicSitePage({
        slug: view.site.slug,
        doctorName: view.site.doctorName,
        address: view.site.address,
        officePhone: view.site.officePhone,
        hasLogo: view.site.logoFile !== null,
      }),
    );
  });

  app.get("/c/:slug/logo", PUBLIC_RATE_LIMIT, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const view = await services.site.resolveSite(slug);
    if (view.kind !== "published" || view.site.logoFile === null) throw new NotFoundError();
    const logo = await services.logos.read(view.site.logoFile);
    if (!logo) throw new NotFoundError();
    void reply.header("cache-control", "public, max-age=3600");
    return reply.type(logo.mime).send(logo.buffer);
  });

  registerEntryRoutes(app, services);
}

// --- Entrada del paciente ------------------------------------------------------------------------------------------------

/** Límite de intentos de entrada y alta: 10 por minuto por IP. */
const ENTRY_RATE_LIMIT = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } } as const;

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const moment = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(moment.getTime()) && moment.toISOString().startsWith(value);
  });

/** Solo se conserva una fecha válida (AAAA-MM-DD); cualquier otro valor se descarta para que la redirección sea siempre interna. */
function validDate(value: unknown): string | null {
  const parsed = dateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function reserveUrl(site: PublishedSite, fecha: string | null): string {
  return `/c/${site.slug}/reservar${fecha === null ? "" : `?fecha=${fecha}`}`;
}

/** El campo `fecha` solo sirve para volver al mismo día; no forma parte del alta. */
function withoutFecha(body: Record<string, unknown>): Record<string, unknown> {
  const { fecha: _fecha, ...rest } = body;
  void _fecha;
  return rest;
}

function stringFields(body: Record<string, unknown>, keys: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const key of keys) {
    const value = body[key];
    values[key] = typeof value === "string" ? value.slice(0, 300) : "";
  }
  return values;
}

function registerEntryRoutes(app: FastifyInstance, services: Services): void {
  /** Devuelve el consultorio publicado, o responde (404 / aviso de que se confirme por teléfono) y devuelve null. */
  async function publishedSite(request: FastifyRequest, reply: FastifyReply, slug: string): Promise<PublishedSite | null> {
    const view: SiteView = await services.site.resolveSite(slug);
    if (view.kind === "missing") throw new NotFoundError();
    if (view.kind === "unavailable") {
      void reply.type("text/html; charset=utf-8").send(unavailableSitePage({ doctorName: view.doctorName, officePhone: view.officePhone }));
      return null;
    }
    return view.site;
  }

  const signedInPatient = (request: FastifyRequest): boolean => isFullyAuthenticated(request.auth) && request.auth.role === "patient";

  app.get("/c/:slug/entrar", PUBLIC_RATE_LIMIT, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const site = await publishedSite(request, reply, slug);
    if (!site) return reply;
    const fecha = validDate((request.query as Record<string, unknown>).fecha);
    if (signedInPatient(request)) return reply.redirect(reserveUrl(site, fecha), 303);
    return reply
      .type("text/html; charset=utf-8")
      .send(entryPage({ slug: site.slug, doctorName: site.doctorName, csrf: app.csrf.tokenFor(request, reply), email: "", fecha }));
  });

  app.post("/c/:slug/entrar", ENTRY_RATE_LIMIT, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const site = await publishedSite(request, reply, slug);
    if (!site) return reply;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const fecha = validDate(body.fecha);
    const parsed = z.object({ email: z.string().min(1).max(254), password: z.string().min(1).max(1000) }).safeParse(body);
    const email = typeof body.email === "string" ? body.email.slice(0, 254) : "";
    const view = (error: string) => entryPage({ slug: site.slug, doctorName: site.doctorName, csrf: app.csrf.tokenFor(request, reply), email, fecha, error });
    if (!parsed.success) return reply.code(400).type("text/html; charset=utf-8").send(view("Escribe tu correo y tu contraseña."));

    const outcome = await services.entry.signIn({
      email: parsed.data.email,
      password: parsed.data.password,
      ip: request.ip,
      deviceCookie: request.cookies[DEVICE_COOKIE],
      currentSessionToken: request.sessionToken,
    });
    if (outcome.kind === "throttled") {
      const seconds = Math.max(1, Math.ceil(outcome.retryAfterMs / 1000));
      return reply
        .code(429)
        .header("retry-after", String(seconds))
        .type("text/html; charset=utf-8")
        .send(view(`Demasiados intentos. Espera ${seconds} segundos e inténtalo de nuevo.`));
    }
    if (outcome.kind === "invalid") return reply.code(401).type("text/html; charset=utf-8").send(view("Correo o contraseña incorrectos."));
    if (outcome.kind === "no_account") {
      // Se acepta que esto revele que no hay cuenta de paciente con ese correo (mitigado con la espera creciente y el límite por IP).
      return reply.type("text/html; charset=utf-8").send(
        firstAppointmentPage({
          slug: site.slug,
          doctorName: site.doctorName,
          csrf: app.csrf.tokenFor(request, reply),
          values: { email },
          errors: {},
          fecha,
          notice: "No encontramos una cuenta de paciente con ese correo. Crea tu cuenta para agendar tu primera cita.",
        }),
      );
    }
    setDeviceCookie(reply, outcome.deviceId);
    setSessionCookie(reply, outcome.sessionToken);
    return reply.redirect(outcome.mfaEnabled ? "/login/mfa" : reserveUrl(site, fecha), 303);
  });

  app.get("/c/:slug/primera-cita", PUBLIC_RATE_LIMIT, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const site = await publishedSite(request, reply, slug);
    if (!site) return reply;
    const fecha = validDate((request.query as Record<string, unknown>).fecha);
    if (signedInPatient(request)) return reply.redirect(reserveUrl(site, fecha), 303);
    return reply
      .type("text/html; charset=utf-8")
      .send(firstAppointmentPage({ slug: site.slug, doctorName: site.doctorName, csrf: app.csrf.tokenFor(request, reply), values: {}, errors: {}, fecha }));
  });

  app.post("/c/:slug/primera-cita", ENTRY_RATE_LIMIT, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const site = await publishedSite(request, reply, slug);
    if (!site) return reply;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const fecha = validDate(body.fecha);
    try {
      const { sessionToken } = await services.entry.registerFirstAppointment(withoutFecha(body), request.sessionToken);
      setSessionCookie(reply, sessionToken);
      return reply.redirect(reserveUrl(site, fecha), 303);
    } catch (error) {
      if (error instanceof ValidationError) {
        const values = stringFields(body, ["fullName", "birthDate", "email", "phone"]);
        return reply
          .code(400)
          .type("text/html; charset=utf-8")
          .send(firstAppointmentPage({ slug: site.slug, doctorName: site.doctorName, csrf: app.csrf.tokenFor(request, reply), values, errors: error.fields ?? {}, fecha }));
      }
      throw error;
    }
  });
}
