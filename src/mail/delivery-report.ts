import type { RowDataPacket } from "mysql2/promise";
import type { Db } from "../db/pool.js";

export const DELIVERY_TARGET_PERCENT = 98;

export interface TemplateDelivery {
  template: string;
  sent: number;
  failed: number;
  queued: number;
  cancelled: number;
}

export interface DeliveryReport {
  from: Date;
  to: Date;
  sent: number;
  failed: number;
  queued: number;
  /** Cancelados antes de enviarse (no cuentan como fallo de entrega). */
  cancelled: number;
  /** Entregados sobre resueltos (`sent / (sent + failed)`), o `null` si todavía no hay correos resueltos. */
  deliveredPercent: number | null;
  /** Verdadero si se cumple la meta de SC-010 (más de 98 %); `null` si no hay datos. */
  meetsTarget: boolean | null;
  byTemplate: TemplateDelivery[];
}

/**
 * Porcentaje de correos entregados del outbox en un periodo (meta SC-010: más de 98 %). Los pendientes no cuentan
 * como fallos. El informe NO incluye direcciones ni contenido: solo conteos por plantilla.
 */
export async function deliveryReport(db: Db, range: { from: Date; to: Date }): Promise<DeliveryReport> {
  const [rows] = await db.execute<RowDataPacket[]>(
    `SELECT template, status, COUNT(*) AS n FROM email_outbox
      WHERE created_at >= ? AND created_at < ? GROUP BY template, status ORDER BY template`,
    [range.from, range.to],
  );

  const byTemplate = new Map<string, TemplateDelivery>();
  let sent = 0;
  let failed = 0;
  let queued = 0;
  let cancelled = 0;
  for (const row of rows) {
    const template = String(row.template);
    const entry = byTemplate.get(template) ?? { template, sent: 0, failed: 0, queued: 0, cancelled: 0 };
    const n = Number(row.n);
    if (row.status === "sent") {
      entry.sent += n;
      sent += n;
    } else if (row.status === "failed") {
      entry.failed += n;
      failed += n;
    } else if (row.status === "cancelled") {
      entry.cancelled += n;
      cancelled += n;
    } else {
      entry.queued += n;
      queued += n;
    }
    byTemplate.set(template, entry);
  }

  const resolved = sent + failed;
  const deliveredPercent = resolved === 0 ? null : Math.round((sent / resolved) * 1000) / 10;
  return {
    from: range.from,
    to: range.to,
    sent,
    failed,
    queued,
    cancelled,
    deliveredPercent,
    meetsTarget: deliveredPercent === null ? null : deliveredPercent > DELIVERY_TARGET_PERCENT,
    byTemplate: [...byTemplate.values()],
  };
}
