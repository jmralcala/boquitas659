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
            d.full_name AS doctor_name, d.office_phone, d.approval_status, d.account_state
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
    // «Aprobado» aquí significa que el consultorio puede aceptar reservas: cédula aprobada y cuenta activa (ni suspendida ni en solo lectura).
    doctorApproved: row.approval_status === "approved" && row.account_state === "active",
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
  // Un nombre que fue de otro consultorio queda reservado para él durante 90 días (cambio de enlace hecho por soporte).
  const [reserved] = await executor.execute<RowDataPacket[]>(
    "SELECT doctor_id FROM site_slug_reservation WHERE slug = ? AND reserved_until > ? AND doctor_id <> ?",
    [slug, now, ctx.doctorId],
  );
  if (reserved.length > 0) return "slug_taken";
  try {
    await executor.execute("INSERT INTO doctor_site (doctor_id, slug, status, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?)", [
      ctx.doctorId,
      slug,
      now,
      now,
    ]);
    // El INSERT puede haber esperado a que soporte confirmara un cambio de enlace que reservó este nombre: se relee con
    // bloqueo (ve lo último confirmado) y, si quedó reservado para otro consultorio, la transacción del llamador se revierte.
    const [late] = await executor.execute<RowDataPacket[]>(
      "SELECT doctor_id FROM site_slug_reservation WHERE slug = ? AND reserved_until > ? AND doctor_id <> ? FOR UPDATE",
      [slug, now, ctx.doctorId],
    );
    if (late.length > 0) return "slug_taken";
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
 * ¿El consultorio acepta reservas en este momento? Micrositio publicado, médico aprobado y cuenta activa, sin suspender ni en solo lectura (la misma condición con la
 * que el micrositio público ofrece las opciones de reserva). Se comprueba dentro de la transacción de la reserva.
 */
export async function isAcceptingBookings(ctx: TenantContext, executor: Executor): Promise<boolean> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT s.doctor_id FROM doctor_site s JOIN doctor d ON d.id = s.doctor_id
      WHERE s.doctor_id = ? AND s.status = 'published' AND d.approval_status = 'approved' AND d.account_state = 'active'`,
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
