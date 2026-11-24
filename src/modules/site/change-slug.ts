import type { RowDataPacket } from "mysql2/promise";
import type { Db } from "../../db/pool.js";
import { withTransaction } from "../../db/tx.js";
import { ConflictError, NotFoundError, ValidationError } from "../../http/errors.js";
import type { Clock } from "../../lib/clock.js";
import { normalizeEmail } from "../../lib/normalize.js";
import { isValidSlug, slugErrors } from "../../lib/site-slug.js";
import { enqueueEmail } from "../../mail/outbox.js";
import { appendSupportAction } from "../support/action-log.js";

/** Días que el nombre anterior queda reservado para su dueño (nadie más puede tomarlo en ese plazo). */
export const SLUG_RESERVATION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ChangeSlugAsSupportInput {
  /** Persona de soporte que hace el cambio (queda en el historial). */
  supportUserId: number;
  currentSlug: string;
  newSlug: string;
  /** Motivo interno; el procedimiento por línea de comandos usa uno fijo. */
  reason: string;
}

/**
 * Cambia el nombre del enlace de un micrositio (lo hace soporte: el médico no puede, porque quien lo publicó ya lo
 * compartió). Una sola transacción: bloquea la fila del micrositio, valida que el nombre nuevo sea válido, esté libre y
 * no esté reservado por otro médico, lo cambia, reserva el nombre anterior 90 días para su dueño, deja `site_updated`
 * con el rol `support` en el registro de la agenda, la entrada del historial de soporte y el aviso fijo al médico.
 */
export async function changeSlugAsSupport(db: Db, clock: Clock, input: ChangeSlugAsSupportInput): Promise<{ doctorId: number }> {
  if (!isValidSlug(input.currentSlug)) throw new NotFoundError();
  if (!isValidSlug(input.newSlug)) throw new ValidationError({ slug: slugErrors(input.newSlug) });

  return withTransaction(db, async (connection) => {
    const [sites] = await connection.execute<RowDataPacket[]>("SELECT doctor_id, slug FROM doctor_site WHERE slug = ? FOR UPDATE", [input.currentSlug]);
    // La base compara sin distinguir mayúsculas: se exige la coincidencia exacta.
    const site = sites[0];
    if (!site || String(site.slug) !== input.currentSlug) throw new NotFoundError();
    const doctorId = Number(site.doctor_id);
    if (input.newSlug === input.currentSlug) throw new ValidationError({ slug: ["Ese ya es el nombre actual del enlace."] });

    const now = clock.now();
    const [reserved] = await connection.execute<RowDataPacket[]>("SELECT doctor_id FROM site_slug_reservation WHERE slug = ? AND reserved_until > ?", [input.newSlug, now]);
    if (reserved[0] && Number(reserved[0].doctor_id) !== doctorId) throw new ConflictError("Ese nombre ya está en uso.", "slug_taken");

    try {
      await connection.execute("UPDATE doctor_site SET slug = ?, updated_at = ? WHERE doctor_id = ?", [input.newSlug, now, doctorId]);
    } catch (error) {
      // 1062 = el nombre ya lo tiene otro micrositio.
      if ((error as { errno?: number }).errno === 1062) throw new ConflictError("Ese nombre ya está en uso.", "slug_taken");
      throw error;
    }
    // El dueño recupera un nombre suyo; el nombre anterior queda reservado para él.
    await connection.execute("DELETE FROM site_slug_reservation WHERE slug = ? AND doctor_id = ?", [input.newSlug, doctorId]);
    await connection.execute(
      `INSERT INTO site_slug_reservation (slug, doctor_id, reserved_until) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE doctor_id = VALUES(doctor_id), reserved_until = VALUES(reserved_until)`,
      [input.currentSlug, doctorId, new Date(now.getTime() + SLUG_RESERVATION_DAYS * DAY_MS)],
    );
    await connection.execute(
      `INSERT INTO calendar_action_log (doctor_id, actor_user_id, actor_role, action, outcome, occurred_at)
       VALUES (?, ?, 'support', 'site_updated', 'ok', ?)`,
      [doctorId, input.supportUserId, now],
    );
    await appendSupportAction(connection, { supportUserId: input.supportUserId, action: "change_slug", targetType: "site", targetId: doctorId, reason: input.reason, occurredAt: now });
    const [owners] = await connection.execute<RowDataPacket[]>("SELECT u.email FROM doctor d JOIN `user` u ON u.id = d.user_id WHERE d.id = ?", [doctorId]);
    if (owners[0]) await enqueueEmail(connection, { template: "doctor_site_slug_changed", to: String(owners[0].email), payload: { doctorId, slug: input.newSlug } }, clock);
    return { doctorId };
  });
}

export interface ChangeSlugInput {
  /** Correo de la persona de soporte que hace el cambio (procedimiento por línea de comandos). */
  supportEmail: string;
  currentSlug: string;
  newSlug: string;
}

/** Procedimiento por línea de comandos: identifica a soporte por su correo y usa el mismo cambio que el panel. */
export async function changeSiteSlug(db: Db, clock: Clock, input: ChangeSlugInput): Promise<{ doctorId: number }> {
  if (!isValidSlug(input.currentSlug)) throw new NotFoundError();
  if (!isValidSlug(input.newSlug)) throw new ValidationError({ nuevo: slugErrors(input.newSlug) });
  const email = normalizeEmail(input.supportEmail);
  const [users] = await db.execute<RowDataPacket[]>("SELECT id FROM `user` WHERE email_normalized = ? AND role = 'support' AND status = 'active'", [email ?? ""]);
  const supportUserId = users[0] ? Number(users[0].id) : null;
  if (supportUserId === null) throw new NotFoundError();
  return changeSlugAsSupport(db, clock, { supportUserId, currentSlug: input.currentSlug, newSlug: input.newSlug, reason: "Cambio hecho por el procedimiento de línea de comandos." });
}
