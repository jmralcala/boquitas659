import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { Db } from "../db/pool.js";
import type { Clock } from "../lib/clock.js";

/** La categoría de una urgencia no puede quedar en la cola de envío más de 24 horas (constitución I). */
export const URGENT_CATEGORY_MAX_AGE_MS = 24 * 3_600_000;
const BATCH_SIZE = 200;

/**
 * Convierte en aviso genérico (sin categoría) los avisos de urgencia que llevan 24 horas o más en cola sin entregarse.
 * Es idempotente y segura si dos procesos coinciden: cada fila se cambia con una actualización condicional sobre su estado,
 * así que solo un proceso la convierte. El aviso genérico sale en el siguiente ciclo del outbox. Devuelve cuántos convirtió.
 */
export async function expireUrgentCategories(db: Db, clock: Clock): Promise<number> {
  const cutoff = new Date(clock.now().getTime() - URGENT_CATEGORY_MAX_AGE_MS);
  const [candidates] = await db.execute<RowDataPacket[]>(
    `SELECT id, payload_ref FROM email_outbox
      WHERE template = 'doctor_urgent_notice' AND status = 'queued' AND created_at <= ?
      ORDER BY id LIMIT ${BATCH_SIZE}`,
    [cutoff],
  );
  let converted = 0;
  for (const row of candidates) {
    let appointmentId: unknown;
    try {
      appointmentId = (JSON.parse(String(row.payload_ref)) as { appointmentId?: unknown }).appointmentId;
    } catch {
      appointmentId = undefined;
    }
    // Solo se conserva el identificador de la cita: la categoría se descarta aquí mismo.
    const clean = JSON.stringify(typeof appointmentId === "number" ? { appointmentId } : {});
    const [result] = await db.execute<ResultSetHeader>(
      "UPDATE email_outbox SET template = 'doctor_urgent_generic', payload_ref = ? WHERE id = ? AND template = 'doctor_urgent_notice' AND status = 'queued'",
      [clean, Number(row.id)],
    );
    if (result.affectedRows === 1) converted += 1;
  }
  return converted;
}
