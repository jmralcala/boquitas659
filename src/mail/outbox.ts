import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { Db } from "../db/pool.js";
import { withTransaction } from "../db/tx.js";
import { systemClock, type Clock } from "../lib/clock.js";
import type { OneTimeTokenService } from "../modules/auth/one-time-tokens.js";
import type { MailTransport } from "./transport.js";
import type { EmailPayload, TemplateRegistry } from "./templates.js";

type Executor = Pick<Db, "execute">;

/** Encola un correo. Solo guarda la plantilla, el destinatario y los identificadores del `payload`. */
export async function enqueueEmail(
  executor: Executor,
  email: { template: string; to: string; payload?: EmailPayload },
  clock: Clock = systemClock,
): Promise<void> {
  const now = clock.now();
  await executor.execute(
    "INSERT INTO email_outbox (template, to_email, payload_ref, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?)",
    [email.template, email.to, JSON.stringify(email.payload ?? {}), now, now],
  );
}

/** Evento de registro técnico del outbox: solo identificadores y el tipo/código del error, nunca mensajes ni destinatarios. */
export interface OutboxLogEvent {
  event: "send_failed" | "gave_up" | "cancelled";
  id: number;
  template: string;
  attempts: number;
  errorName?: string;
  errorCode?: string;
}

export interface OutboxDeps {
  db: Db;
  transport: MailTransport;
  tokens: OneTimeTokenService;
  templates: TemplateRegistry;
  baseUrl: string;
  clock?: Clock;
  batchSize?: number;
  maxAttempts?: number;
  /** Tiempo que una fila queda reservada mientras se envía. Debe ser mayor que los timeouts del transporte. */
  claimMs?: number;
  /** Destino de los eventos de registro técnico (la tarea de cron escribe a stderr). */
  log?: (event: OutboxLogEvent) => void;
}

export interface OutboxResult {
  sent: number;
  retried: number;
  failed: number;
  cancelled: number;
}

const BACKOFF_CAP_MINUTES = 60;

/**
 * Procesa los correos vencidos. Es idempotente y seguro si el cron se solapa: cada fila se reserva con una
 * actualización condicional, así que un correo solo lo envía un proceso. Las plantillas con enlace crean su
 * token de un solo uso dentro de la misma transacción que marca el correo como enviado; si el envío falla se
 * revierte y el token anterior sigue vigente. El cuerpo enviado nunca se guarda.
 *
 * Semántica de entrega: AL MENOS UNA VEZ. Si el envío SMTP tiene éxito pero la transacción posterior falla, el
 * reintento envía otro correo (y el primero queda con un enlace sin efecto): con SMTP no se puede evitar del todo.
 * Los timeouts del transporte son menores que `claimMs` para que otro proceso no reclame una fila que sigue enviándose.
 * Una plantilla puede cancelar el correo (`shouldSend`) si ya no tiene sentido enviarlo.
 */
export async function processOutbox(deps: OutboxDeps): Promise<OutboxResult> {
  const clock = deps.clock ?? systemClock;
  const batchSize = Math.max(1, Math.floor(deps.batchSize ?? 20));
  const maxAttempts = deps.maxAttempts ?? 6;
  const claimMs = deps.claimMs ?? 2 * 60_000;
  const result: OutboxResult = { sent: 0, retried: 0, failed: 0, cancelled: 0 };

  const [candidates] = await deps.db.query<RowDataPacket[]>(
    `SELECT id FROM email_outbox
      WHERE status = 'queued' AND next_attempt_at <= ? AND (locked_until IS NULL OR locked_until <= ?)
      ORDER BY id LIMIT ${batchSize}`,
    [clock.now(), clock.now()],
  );

  for (const candidate of candidates) {
    const id = Number(candidate.id);
    const now = clock.now();
    const [claim] = await deps.db.execute<ResultSetHeader>(
      `UPDATE email_outbox SET locked_until = ?
        WHERE id = ? AND status = 'queued' AND (locked_until IS NULL OR locked_until <= ?)`,
      [new Date(now.getTime() + claimMs), id, now],
    );
    if (claim.affectedRows !== 1) continue; // otro proceso la reservó

    const [rows] = await deps.db.execute<RowDataPacket[]>(
      "SELECT template, to_email, payload_ref, attempts FROM email_outbox WHERE id = ?",
      [id],
    );
    const row = rows[0];
    if (!row) continue;
    const attempts = Number(row.attempts) + 1;
    const templateName = String(row.template);

    try {
      const template = deps.templates[templateName];
      if (!template) throw Object.assign(new Error("Plantilla desconocida"), { code: "UNKNOWN_TEMPLATE" });
      const payload = JSON.parse(String(row.payload_ref)) as EmailPayload;

      // Si el correo ya no tiene sentido (invitación revocada, otro cambio de correo pedido), se cancela sin enviar.
      if (template.shouldSend && !(await template.shouldSend({ payload, db: deps.db, now: clock.now() }))) {
        await deps.db.execute("UPDATE email_outbox SET status = 'cancelled', attempts = ?, locked_until = NULL WHERE id = ?", [attempts - 1, id]);
        result.cancelled += 1;
        deps.log?.({ event: "cancelled", id, template: templateName, attempts: attempts - 1 });
        continue;
      }

      await withTransaction(deps.db, async (connection) => {
        let link: string | null = null;
        if (template.token) {
          const { token } = await deps.tokens.create(
            { purpose: template.token.purpose, ttlMs: template.token.ttlMs, ...template.token.subject(payload) },
            connection,
          );
          link = new URL(template.token.linkPath(token), deps.baseUrl).toString();
        }
        const rendered = await template.render({ payload, link, baseUrl: deps.baseUrl, db: deps.db, now: clock.now() });
        await deps.transport.send({ to: String(row.to_email), ...rendered });
        await connection.execute(
          "UPDATE email_outbox SET status = 'sent', sent_at = ?, attempts = ?, locked_until = NULL WHERE id = ?",
          [clock.now(), attempts, id],
        );
      });
      result.sent += 1;
    } catch (error) {
      // Se registra solo el tipo y el código del error: el mensaje y el cuerpo pueden contener datos personales.
      const info = error as { name?: string; code?: string };
      const base = { id, template: templateName, attempts, errorName: info.name, errorCode: info.code };
      if (attempts >= maxAttempts) {
        await deps.db.execute(
          "UPDATE email_outbox SET status = 'failed', attempts = ?, locked_until = NULL WHERE id = ?",
          [attempts, id],
        );
        result.failed += 1;
        deps.log?.({ event: "gave_up", ...base });
      } else {
        const minutes = Math.min(2 ** (attempts - 1), BACKOFF_CAP_MINUTES);
        await deps.db.execute(
          "UPDATE email_outbox SET attempts = ?, next_attempt_at = ?, locked_until = NULL WHERE id = ?",
          [attempts, new Date(clock.now().getTime() + minutes * 60_000), id],
        );
        result.retried += 1;
        deps.log?.({ event: "send_failed", ...base });
      }
    }
  }
  return result;
}
