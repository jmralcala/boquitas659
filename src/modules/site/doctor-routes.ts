import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Services } from "../../compose.js";
import { ForbiddenError, ValidationError } from "../../http/errors.js";
import { wantsJson } from "../../http/negotiation.js";
import { parseInput } from "../../http/validate.js";
import { doctorSitePage, type DoctorSiteView } from "../../http/views/site.js";
import type { StaffContext } from "../../lib/tenant.js";
import { chooseName, publish, removeLogo, replaceLogo, saveAddress, siteStatus, unpublish, type SiteDeps } from "./site-service.js";

/** Solo el médico (no recepción) administra su micrositio. */
export async function resolveDoctorOnly(services: Services, request: FastifyRequest): Promise<StaffContext> {
  const tenant = await services.tenants.resolve(request);
  if (tenant.actor.kind !== "doctor") throw new ForbiddenError();
  return tenant;
}

const nameBody = z.object({ slug: z.string().max(100, "El nombre es demasiado largo.").default("") });
const addressBody = z.object({ address: z.string().max(2000, "La dirección es demasiado larga.").default("") });

/** Rutas del médico para su micrositio (contracts/http-routes.md). El médico sale siempre del contexto de la sesión. */
export function registerSiteDoctorRoutes(app: FastifyInstance, services: Services): void {
  const deps = (): SiteDeps => ({ db: services.db, clock: services.clock, logos: services.logos });

  async function viewFor(tenant: StaffContext): Promise<DoctorSiteView> {
    const { site, missing } = await siteStatus(tenant, deps());
    return {
      site: site
        ? {
            slug: site.slug,
            address: site.address,
            status: site.status,
            hasLogo: site.logoFile !== null,
            url: new URL(`/c/${site.slug}`, services.env.PUBLIC_BASE_URL).toString(),
          }
        : null,
      missing,
    };
  }

  async function render(
    request: FastifyRequest,
    reply: FastifyReply,
    tenant: StaffContext,
    page: { status?: number; values?: Record<string, string>; errors?: Readonly<Record<string, readonly string[]>> } = {},
  ): Promise<FastifyReply> {
    const view = await viewFor(tenant);
    if (wantsJson(request)) return reply.send(view);
    return reply
      .code(page.status ?? 200)
      .type("text/html; charset=utf-8")
      .send(doctorSitePage({ csrf: app.csrf.tokenFor(request, reply), view, ...(page.values ? { values: page.values } : {}), ...(page.errors ? { errors: page.errors } : {}) }));
  }

  /** Ejecuta una acción del médico; si falla por validación en HTML repinta la pantalla con los errores. */
  async function act(
    request: FastifyRequest,
    reply: FastifyReply,
    tenant: StaffContext,
    action: () => Promise<void>,
    values: Record<string, string> = {},
  ): Promise<FastifyReply> {
    try {
      await action();
    } catch (error) {
      if (error instanceof ValidationError && !wantsJson(request)) return render(request, reply, tenant, { status: 400, values, errors: error.fields ?? {} });
      throw error;
    }
    return reply.redirect("/medicos/micrositio", 303);
  }

  app.get("/medicos/micrositio", async (request, reply) => {
    const tenant = await resolveDoctorOnly(services, request);
    return render(request, reply, tenant);
  });

  app.post("/medicos/micrositio/nombre", async (request, reply) => {
    const tenant = await resolveDoctorOnly(services, request);
    const { slug } = parseInput(nameBody, request.body ?? {});
    return act(request, reply, tenant, () => chooseName(tenant, deps(), slug), { slug: slug.slice(0, 100) });
  });

  app.post("/medicos/micrositio", async (request, reply) => {
    const tenant = await resolveDoctorOnly(services, request);
    const { address } = parseInput(addressBody, request.body ?? {});
    return act(request, reply, tenant, () => saveAddress(tenant, deps(), address), { address: address.slice(0, 300) });
  });

  app.post("/medicos/micrositio/logo", async (request, reply) => {
    const tenant = await resolveDoctorOnly(services, request);
    const file = (request.body as { logo?: unknown } | undefined)?.logo;
    return act(request, reply, tenant, async () => {
      if (!Buffer.isBuffer(file)) throw new ValidationError({ logo: ["Elige un archivo de imagen."] });
      await replaceLogo(tenant, deps(), file);
    });
  });

  app.post("/medicos/micrositio/logo/quitar", async (request, reply) => {
    const tenant = await resolveDoctorOnly(services, request);
    return act(request, reply, tenant, () => removeLogo(tenant, deps()));
  });

  app.post("/medicos/micrositio/publicar", async (request, reply) => {
    const tenant = await resolveDoctorOnly(services, request);
    return act(request, reply, tenant, () => publish(tenant, deps()));
  });

  app.post("/medicos/micrositio/despublicar", async (request, reply) => {
    const tenant = await resolveDoctorOnly(services, request);
    return act(request, reply, tenant, () => unpublish(tenant, deps()));
  });
}
