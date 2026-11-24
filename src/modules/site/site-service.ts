import type { PoolConnection } from "mysql2/promise";
import type { Db } from "../../db/pool.js";
import { AppError, ConflictError, ForbiddenError, ValidationError } from "../../http/errors.js";
import type { Clock } from "../../lib/clock.js";
import { slugErrors } from "../../lib/site-slug.js";
import type { StaffContext } from "../../lib/tenant.js";
import { logCalendarAction } from "../calendar/action-log.js";
import { withCalendarLock } from "../calendar/calendar-lock.js";
import { loadSettings } from "../calendar/settings-repository.js";
import { findDoctorByUserId } from "../doctors/doctor-repository.js";
import { detectLogoType, type LogoStorage } from "./logo-storage.js";
import { findSiteForDoctor, insertSiteName, setLogo, setStatus, updateAddress, type SiteRecord } from "./site-repository.js";

export const MAX_ADDRESS_LENGTH = 300;

export interface SiteDeps {
  db: Db;
  clock: Clock;
  logos: LogoStorage;
}

/** No se puede publicar todavía: faltan datos. `missing` los lista en español. */
export class SitePublishIncompleteError extends AppError {
  constructor(readonly missing: readonly string[]) {
    super(409, "site_incomplete", `Para publicar falta: ${missing.join(", ")}.`, { missing });
    this.name = "SitePublishIncompleteError";
  }
}

/** Solo el médico (no recepción) administra su micrositio. */
function assertDoctor(ctx: StaffContext): void {
  if (ctx.actor.kind !== "doctor") throw new ForbiddenError();
}

async function requireSite(ctx: StaffContext, connection: PoolConnection): Promise<SiteRecord> {
  const site = await findSiteForDoctor(ctx, connection);
  if (!site) throw new ConflictError("Primero elige el nombre de tu enlace.", "site_without_name");
  return site;
}

/** Qué falta para publicar (vacío = se puede publicar). */
async function missingToPublish(ctx: StaffContext, connection: PoolConnection, site: SiteRecord | null): Promise<string[]> {
  const missing: string[] = [];
  if (!site) missing.push("nombre del enlace");
  if (!site?.address) missing.push("dirección");
  const doctor = await findDoctorByUserId(connection, ctx.actor.userId);
  if (!doctor?.officePhone) missing.push("teléfono del consultorio");
  const { hours } = await loadSettings(ctx, connection);
  if (hours.length === 0) missing.push("horario de atención (al menos una franja)");
  return missing;
}

/** Elige el nombre del enlace, una sola vez. La unicidad la decide el índice (el primero que lo registra se queda con él). */
export async function chooseName(ctx: StaffContext, deps: SiteDeps, rawSlug: string): Promise<void> {
  assertDoctor(ctx);
  const errors = slugErrors(rawSlug);
  if (errors.length > 0) throw new ValidationError({ slug: errors });
  await withCalendarLock(ctx, deps.db, async (connection) => {
    const now = deps.clock.now();
    if (await findSiteForDoctor(ctx, connection)) {
      throw new ConflictError("Ya elegiste el nombre de tu enlace. Solo soporte puede cambiarlo.", "slug_locked");
    }
    if ((await insertSiteName(ctx, connection, rawSlug, now)) === "slug_taken") {
      throw new ConflictError("Ese nombre ya está en uso. Elige otro.", "slug_taken");
    }
    await logCalendarAction(ctx, connection, { action: "site_updated", outcome: "ok", at: now });
  });
}

/** Guarda la dirección del consultorio (texto de 1 a 300 caracteres, sin caracteres de control). */
export async function saveAddress(ctx: StaffContext, deps: SiteDeps, rawAddress: string): Promise<void> {
  assertDoctor(ctx);
  const address = rawAddress.trim();
  const errors: string[] = [];
  if (address.length === 0) errors.push("Escribe la dirección del consultorio.");
  if (address.length > MAX_ADDRESS_LENGTH) errors.push(`La dirección admite hasta ${MAX_ADDRESS_LENGTH} caracteres.`);
  // eslint-disable-next-line no-control-regex -- se rechazan a propósito los caracteres de control
  if (/[\u0000-\u001f\u007f]/.test(address)) errors.push("La dirección no puede llevar caracteres de control.");
  if (errors.length > 0) throw new ValidationError({ address: errors });
  await withCalendarLock(ctx, deps.db, async (connection) => {
    await requireSite(ctx, connection);
    const now = deps.clock.now();
    await updateAddress(ctx, connection, address, now);
    await logCalendarAction(ctx, connection, { action: "site_updated", outcome: "ok", at: now });
  });
}

/** Reemplaza el logo (PNG, JPEG o WebP de hasta 1 MB, validado por su contenido) y borra el anterior. */
export async function replaceLogo(ctx: StaffContext, deps: SiteDeps, buffer: Buffer): Promise<void> {
  assertDoctor(ctx);
  const check = detectLogoType(buffer);
  if (!check.ok) {
    const message = check.reason === "size" ? "El logo pesa más de 1 MB." : check.reason === "empty" ? "Elige un archivo." : "El logo debe ser una imagen PNG, JPEG o WebP.";
    throw new ValidationError({ logo: [message] });
  }
  // Primero se comprueba que hay dónde guardarlo; el archivo se escribe solo si la transacción va a poder usarlo.
  await withCalendarLock(ctx, deps.db, async (connection) => requireSite(ctx, connection));
  const saved = await deps.logos.save(buffer);
  try {
    const previous = await withCalendarLock(ctx, deps.db, async (connection) => {
      const site = await requireSite(ctx, connection);
      const now = deps.clock.now();
      await setLogo(ctx, connection, saved.name, now);
      await logCalendarAction(ctx, connection, { action: "site_updated", outcome: "ok", at: now });
      return site.logoFile;
    });
    if (previous) await deps.logos.remove(previous);
  } catch (error) {
    await deps.logos.remove(saved.name);
    throw error;
  }
}

export async function removeLogo(ctx: StaffContext, deps: SiteDeps): Promise<void> {
  assertDoctor(ctx);
  const previous = await withCalendarLock(ctx, deps.db, async (connection) => {
    const site = await requireSite(ctx, connection);
    const now = deps.clock.now();
    await setLogo(ctx, connection, null, now);
    await logCalendarAction(ctx, connection, { action: "site_updated", outcome: "ok", at: now });
    return site.logoFile;
  });
  if (previous) await deps.logos.remove(previous);
}

/** Publica el micrositio. Exige médico aprobado, nombre, dirección, teléfono del consultorio y al menos una franja. */
export async function publish(ctx: StaffContext, deps: SiteDeps): Promise<void> {
  assertDoctor(ctx);
  await withCalendarLock(ctx, deps.db, async (connection) => {
    const doctor = await findDoctorByUserId(connection, ctx.actor.userId);
    if (!doctor || doctor.approvalStatus !== "approved") throw new ForbiddenError("Tu cuenta aún no está aprobada.");
    const site = await findSiteForDoctor(ctx, connection);
    const missing = await missingToPublish(ctx, connection, site);
    if (missing.length > 0) throw new SitePublishIncompleteError(missing);
    const now = deps.clock.now();
    await setStatus(ctx, connection, "published", now);
    await logCalendarAction(ctx, connection, { action: "site_updated", outcome: "ok", at: now });
  });
}

/** Despublica: el enlace deja de aceptar reservas; las citas y los bloqueos existentes se conservan. */
export async function unpublish(ctx: StaffContext, deps: SiteDeps): Promise<void> {
  assertDoctor(ctx);
  await withCalendarLock(ctx, deps.db, async (connection) => {
    const site = await findSiteForDoctor(ctx, connection);
    if (!site || site.status !== "published") {
      throw new ConflictError("Tu micrositio no está publicado.", "site_not_published");
    }
    const now = deps.clock.now();
    await setStatus(ctx, connection, "unpublished", now);
    await logCalendarAction(ctx, connection, { action: "site_updated", outcome: "ok", at: now });
  });
}

/** Estado del micrositio del médico y lo que falta para publicarlo. */
export async function siteStatus(ctx: StaffContext, deps: SiteDeps): Promise<{ site: SiteRecord | null; missing: string[] }> {
  assertDoctor(ctx);
  const site = await findSiteForDoctor(ctx, deps.db);
  const connection = await deps.db.getConnection();
  try {
    return { site, missing: await missingToPublish(ctx, connection, site) };
  } finally {
    connection.release();
  }
}
