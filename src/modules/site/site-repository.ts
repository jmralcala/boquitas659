import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { StaffContext, TenantContext } from "../../lib/tenant.js";

type Executor = Pick<Pool, "execute"> | Pick<PoolConnection, "execute">;

export type SiteStatus = "draft" | "published" | "unpublished";

/** Fila de `doctor_site` del médico del contexto. */
export interface SiteRecord {
  doctorId: number;
  slug: string;
  address: string | null;
  logoFile: string | null;
  status: SiteStatus;
  firstPublishedAt: Date | null;
  publishedAt: Date | null;
}

function toRecord(row: RowDataPacket): SiteRecord {
  return {
    doctorId: Number(row.doctor_id),
    slug: String(row.slug),
    address: row.address === null ? null : String(row.address),
    logoFile: row.logo_file === null ? null : String(row.logo_file),
    status: row.status as SiteStatus,
    firstPublishedAt: row.first_published_at === null ? null : (row.first_published_at as Date),
    publishedAt: row.published_at === null ? null : (row.published_at as Date),
  };
}

const COLUMNS = "doctor_id, slug, address, logo_file, status, first_published_at, published_at";

/** Resultado de buscar por nombre del enlace: lo mínimo para decidir qué se muestra al público. */
export interface SiteLookup extends SiteRecord {
  doctorName: string;
  officePhone: string | null;
  doctorApproved: boolean;
}

/**
 * Búsqueda PÚBLICA por el nombre exacto del enlace (el micrositio resuelve de aquí al médico). No acepta contexto de
 * médico: el médico es lo que se está resolviendo. Devuelve solo datos que el micrositio muestra.
 */
export async function findSiteBySlug(executor: Executor, slug: string): Promise<SiteLookup | null> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT s.doctor_id, s.slug, s.address, s.logo_file, s.status, s.first_published_at, s.published_at,
            d.full_name AS doctor_name, d.office_phone, d.approval_status
       FROM doctor_site s JOIN doctor d ON d.id = s.doctor_id
      WHERE s.slug = ?`,
    [slug],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    ...toRecord(row),
    doctorName: String(row.doctor_name),
    officePhone: row.office_phone === null ? null : String(row.office_phone),
    doctorApproved: row.approval_status === "approved",
  };
}

export async function findSiteForDoctor(ctx: StaffContext, executor: Executor): Promise<SiteRecord | null> {
  const [rows] = await executor.execute<RowDataPacket[]>(`SELECT ${COLUMNS} FROM doctor_site WHERE doctor_id = ?`, [ctx.doctorId]);
  return rows[0] ? toRecord(rows[0]) : null;
}

/**
 * Reserva el nombre del enlace para el médico. La unicidad la decide el índice: con dos intentos simultáneos solo uno
 * lo consigue y el otro recibe `slug_taken` (sin bloqueos sobre rangos vacíos).
 */
export async function insertSiteName(ctx: StaffContext, executor: Executor, slug: string, now: Date): Promise<"ok" | "slug_taken"> {
  try {
    await executor.execute("INSERT INTO doctor_site (doctor_id, slug, status, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?)", [
      ctx.doctorId,
      slug,
      now,
      now,
    ]);
    return "ok";
  } catch (error) {
    const info = error as { errno?: number; sqlMessage?: string; message?: string };
    if (info.errno === 1062 && String(info.sqlMessage ?? info.message).includes("uq_doctor_site_slug")) return "slug_taken";
    throw error;
  }
}

export async function updateAddress(ctx: StaffContext, executor: Executor, address: string, now: Date): Promise<boolean> {
  const [result] = await executor.execute<ResultSetHeader>("UPDATE doctor_site SET address = ?, updated_at = ? WHERE doctor_id = ?", [address, now, ctx.doctorId]);
  return result.affectedRows === 1;
}

export async function setLogo(ctx: StaffContext, executor: Executor, logoFile: string | null, now: Date): Promise<boolean> {
  const [result] = await executor.execute<ResultSetHeader>("UPDATE doctor_site SET logo_file = ?, updated_at = ? WHERE doctor_id = ?", [logoFile, now, ctx.doctorId]);
  return result.affectedRows === 1;
}

/** Cambia el estado. La primera publicación fija `first_published_at` (distingue «nunca publicado» de «despublicado»). */
export async function setStatus(ctx: StaffContext, executor: Executor, status: SiteStatus, now: Date): Promise<boolean> {
  const [result] = await executor.execute<ResultSetHeader>(
    `UPDATE doctor_site
        SET status = ?, updated_at = ?,
            published_at = IF(? = 'published', ?, published_at),
            first_published_at = IF(? = 'published', COALESCE(first_published_at, ?), first_published_at)
      WHERE doctor_id = ?`,
    [status, now, status, now, status, now, ctx.doctorId],
  );
  return result.affectedRows === 1;
}

/**
 * ¿El consultorio acepta reservas en este momento? Micrositio publicado y médico aprobado (la misma condición con la
 * que el micrositio público ofrece las opciones de reserva). Se comprueba dentro de la transacción de la reserva.
 */
export async function isAcceptingBookings(ctx: TenantContext, executor: Executor): Promise<boolean> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT s.doctor_id FROM doctor_site s JOIN doctor d ON d.id = s.doctor_id
      WHERE s.doctor_id = ? AND s.status = 'published' AND d.approval_status = 'approved'`,
    [ctx.doctorId],
  );
  return rows.length > 0;
}

/** Correo de la cuenta del médico (no el de recepción): a donde van los avisos de citas de pacientes. */
export async function findDoctorAccountEmail(ctx: TenantContext, executor: Executor): Promise<string | null> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    "SELECT u.email FROM doctor d JOIN `user` u ON u.id = d.user_id WHERE d.id = ?",
    [ctx.doctorId],
  );
  return rows[0] ? String(rows[0].email) : null;
}
