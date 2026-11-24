import type { RowDataPacket } from "mysql2/promise";
import type { Db } from "../../db/pool.js";
import { withTransaction } from "../../db/tx.js";
import { ConflictError, NotFoundError, ValidationError } from "../../http/errors.js";
import type { Clock } from "../../lib/clock.js";
import { normalizeEmail } from "../../lib/normalize.js";
import { isValidSlug, slugErrors } from "../../lib/site-slug.js";

export interface ChangeSlugInput {
  /** Correo de la persona de soporte que hace el cambio (queda en el registro de acciones). */
  supportEmail: string;
  currentSlug: string;
  newSlug: string;
}

/**
 * Cambia el nombre del enlace de un micrositio (procedimiento de soporte: el médico no puede cambiarlo, porque quien lo
 * publicó ya lo compartió). El nombre anterior queda libre y deja de resolver. Una sola transacción: bloquea la fila del
 * micrositio, valida que el nombre nuevo sea válido y esté libre, lo cambia y deja `site_updated` con el rol `support`.
 */
export async function changeSiteSlug(db: Db, clock: Clock, input: ChangeSlugInput): Promise<{ doctorId: number }> {
  if (!isValidSlug(input.currentSlug)) throw new NotFoundError();
  if (!isValidSlug(input.newSlug)) throw new ValidationError({ nuevo: slugErrors(input.newSlug) });

  return withTransaction(db, async (connection) => {
    const email = normalizeEmail(input.supportEmail);
    const [users] = await connection.execute<RowDataPacket[]>(
      "SELECT id FROM `user` WHERE email_normalized = ? AND role = 'support' AND status = 'active'",
      [email ?? ""],
    );
    const supportUserId = users[0] ? Number(users[0].id) : null;
    if (supportUserId === null) throw new NotFoundError();

    const [sites] = await connection.execute<RowDataPacket[]>("SELECT doctor_id, slug FROM doctor_site WHERE slug = ? FOR UPDATE", [input.currentSlug]);
    // La base compara sin distinguir mayúsculas: se exige la coincidencia exacta.
    const site = sites[0];
    if (!site || String(site.slug) !== input.currentSlug) throw new NotFoundError();
    const doctorId = Number(site.doctor_id);
    if (input.newSlug === input.currentSlug) return { doctorId };

    const now = clock.now();
    try {
      await connection.execute("UPDATE doctor_site SET slug = ?, updated_at = ? WHERE doctor_id = ?", [input.newSlug, now, doctorId]);
    } catch (error) {
      // 1062 = el nombre ya lo tiene otro micrositio.
      if ((error as { errno?: number }).errno === 1062) throw new ConflictError("Ese nombre ya está en uso.", "slug_taken");
      throw error;
    }
    await connection.execute(
      `INSERT INTO calendar_action_log (doctor_id, actor_user_id, actor_role, action, outcome, occurred_at)
       VALUES (?, ?, 'support', 'site_updated', 'ok', ?)`,
      [doctorId, supportUserId, now],
    );
    return { doctorId };
  });
}
