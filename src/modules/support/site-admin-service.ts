import type { RowDataPacket } from "mysql2/promise";
import type { Db } from "../../db/pool.js";
import { NotFoundError } from "../../http/errors.js";
import { systemClock, type Clock } from "../../lib/clock.js";
import { changeSlugAsSupport } from "../site/change-slug.js";

export type SiteStatus = "draft" | "published" | "unpublished";

export interface SiteRow {
  doctorId: number;
  doctorName: string;
  slug: string;
  status: SiteStatus;
  publishedAt: Date | null;
}

export interface SiteList {
  counts: Record<SiteStatus, number>;
  rows: SiteRow[];
}

export interface SiteAdminService {
  /** Micrositios con su estado y conteos por estado; filtro opcional. Sin datos de pacientes. */
  list(filter: SiteStatus | "all"): Promise<SiteList>;
  /** Nombre actual del enlace de un médico (para la pantalla de cambio), o `null` si no tiene micrositio. */
  currentSlug(doctorId: number): Promise<{ slug: string; doctorName: string } | null>;
  changeSlug(input: { doctorId: number; supportUserId: number; newSlug: string; reason: string }): Promise<void>;
}

export function createSiteAdminService(deps: { db: Db; clock?: Clock }): SiteAdminService {
  const clock = deps.clock ?? systemClock;
  return {
    async list(filter) {
      const [countRows] = await deps.db.execute<RowDataPacket[]>("SELECT status, COUNT(*) AS n FROM doctor_site GROUP BY status");
      const counts: Record<SiteStatus, number> = { draft: 0, published: 0, unpublished: 0 };
      for (const row of countRows) counts[String(row.status) as SiteStatus] = Number(row.n);
      const [rows] = await deps.db.execute<RowDataPacket[]>(
        `SELECT s.doctor_id, d.full_name, s.slug, s.status, s.published_at
           FROM doctor_site s JOIN doctor d ON d.id = s.doctor_id
          ${filter === "all" ? "" : "WHERE s.status = ?"}
          ORDER BY s.slug LIMIT 500`,
        filter === "all" ? [] : [filter],
      );
      return {
        counts,
        rows: rows.map((row) => ({
          doctorId: Number(row.doctor_id),
          doctorName: String(row.full_name),
          slug: String(row.slug),
          status: row.status as SiteStatus,
          publishedAt: row.published_at === null ? null : (row.published_at as Date),
        })),
      };
    },

    async currentSlug(doctorId) {
      const [rows] = await deps.db.execute<RowDataPacket[]>(
        "SELECT s.slug, d.full_name FROM doctor_site s JOIN doctor d ON d.id = s.doctor_id WHERE s.doctor_id = ?",
        [doctorId],
      );
      return rows[0] ? { slug: String(rows[0].slug), doctorName: String(rows[0].full_name) } : null;
    },

    async changeSlug(input) {
      const current = await this.currentSlug(input.doctorId);
      if (!current) throw new NotFoundError();
      await changeSlugAsSupport(deps.db, clock, {
        supportUserId: input.supportUserId,
        currentSlug: current.slug,
        newSlug: input.newSlug,
        reason: input.reason.trim(),
      });
    },
  };
}
