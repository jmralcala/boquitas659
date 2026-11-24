import type { Db } from "../../db/pool.js";
import { ForbiddenError, NotFoundError, SiteUnavailableError, UnauthorizedError } from "../../http/errors.js";
import { isValidSlug } from "../../lib/site-slug.js";
import { createPatientContext, type TenantContext } from "../../lib/tenant.js";
import type { SessionData } from "../auth/sessions.js";
import { findSiteBySlug } from "./site-repository.js";

/** Datos públicos de un micrositio publicado. */
export interface PublishedSite {
  doctorId: number;
  slug: string;
  doctorName: string;
  officePhone: string | null;
  address: string | null;
  logoFile: string | null;
}

export type SiteView =
  /** Publicado y con médico aprobado: se muestra y acepta reservas. */
  | { kind: "published"; site: PublishedSite }
  /** Ya se publicó alguna vez pero hoy no acepta reservas: solo el aviso con nombre y teléfono. */
  | { kind: "unavailable"; doctorName: string; officePhone: string | null }
  /** Nunca se publicó o no existe: se responde igual que una ruta inexistente. */
  | { kind: "missing" };

export interface SiteResolver {
  /** Qué debe mostrar el micrositio público para un nombre de enlace. */
  resolveSite(slug: string): Promise<SiteView>;
  /**
   * ÚNICA vía para obtener un contexto de paciente frente a un consultorio: el médico sale del nombre del enlace
   * (resuelto aquí en el servidor), nunca de un dato que mande el cliente. Exige sesión completa de paciente.
   */
  resolvePatientSite(auth: SessionData | null, slug: string): Promise<{ ctx: TenantContext; site: PublishedSite; auth: SessionData }>;
}

export function createSiteResolver(db: Db): SiteResolver {
  async function resolveSite(slug: string): Promise<SiteView> {
    // La base compara sin distinguir mayúsculas ni espacios finales: se exige el formato y la coincidencia exacta aquí.
    if (!isValidSlug(slug)) return { kind: "missing" };
    const found = await findSiteBySlug(db, slug);
    if (!found || found.slug !== slug || found.firstPublishedAt === null) return { kind: "missing" };
    if (found.status === "published" && found.doctorApproved) {
      return {
        kind: "published",
        site: { doctorId: found.doctorId, slug: found.slug, doctorName: found.doctorName, officePhone: found.officePhone, address: found.address, logoFile: found.logoFile },
      };
    }
    return { kind: "unavailable", doctorName: found.doctorName, officePhone: found.officePhone };
  }

  return {
    resolveSite,
    async resolvePatientSite(auth, slug) {
      // Sesión completa: existe y, si el usuario tiene doble factor, ya lo verificó (los pacientes no lo usan).
      if (auth === null || (auth.mfaEnabled && !auth.mfaVerified)) throw new UnauthorizedError();
      if (auth.role !== "patient") throw new ForbiddenError();
      const view = await resolveSite(slug);
      if (view.kind === "missing") throw new NotFoundError();
      if (view.kind === "unavailable") throw new SiteUnavailableError();
      return { ctx: createPatientContext(view.site.doctorId, auth.userId), site: view.site, auth };
    },
  };
}
