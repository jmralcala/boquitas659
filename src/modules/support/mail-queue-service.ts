import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import type { Db } from "../../db/pool.js";
import { withTransaction } from "../../db/tx.js";
import { ConflictError, NotFoundError } from "../../http/errors.js";
import { systemClock, type Clock } from "../../lib/clock.js";
import type { TemplateRegistry } from "../../mail/templates.js";
import { appendSupportAction, PAGE_SIZE } from "./action-log.js";

export type MailStatus = "queued" | "sent" | "failed" | "cancelled";

/** Lo único que soporte ve de un correo fallido. Nunca el contenido, el `payload`, el asunto ni el destinatario completo. */
export interface FailedMail {
  id: number;
  template: string;
  /** `j***@dominio.com`, calculado en la consulta: la dirección completa no sale de la base. */
  maskedTo: string;
  createdAt: Date;
  attempts: number;
  errorCode: string | null;
  /** `false` para los tipos con datos sensibles (aviso de urgencia): no se reintentan ni se cancelan desde el panel. */
  retryable: boolean;
}

export interface MailQueueSummary {
  counts: Record<MailStatus, number>;
  oldestQueuedAt: Date | null;
  failed: FailedMail[];
  page: number;
  hasNext: boolean;
}

export interface MailActionInput {
  emailId: number;
  supportUserId: number;
  reason: string;
}

export interface MailQueueService {
  summary(page: number): Promise<MailQueueSummary>;
  retry(input: MailActionInput): Promise<void>;
  cancel(input: MailActionInput): Promise<void>;
}

/**
 * Vista y acciones de soporte sobre la cola de correos. Las consultas seleccionan columnas por nombre y NUNCA
 * `payload_ref`: lo que no se lee no se puede mostrar (ni el contenido ni la categoría de una urgencia).
 */
export function createMailQueueService(deps: { db: Db; templates: TemplateRegistry; clock?: Clock }): MailQueueService {
  const clock = deps.clock ?? systemClock;
  const sensitive = new Set(
    Object.entries(deps.templates)
      .filter(([, template]) => (template.sensitiveKeys?.length ?? 0) > 0)
      .map(([name]) => name),
  );

  async function change(input: MailActionInput, from: readonly MailStatus[], apply: (connection: PoolConnection) => Promise<void>, action: "retry_email" | "cancel_email"): Promise<void> {
    await withTransaction(deps.db, async (connection) => {
      const [rows] = await connection.execute<RowDataPacket[]>("SELECT id, template, status, locked_until FROM email_outbox WHERE id = ? FOR UPDATE", [input.emailId]);
      const row = rows[0];
      if (!row) throw new NotFoundError();
      if (sensitive.has(String(row.template))) {
        throw new ConflictError("Este tipo de aviso lo gestiona la cola por sí sola: no se puede reintentar ni cancelar desde el panel.", "not_allowed");
      }
      if (!from.includes(String(row.status) as MailStatus)) {
        throw new ConflictError("El correo ya no está en un estado en el que se pueda hacer eso.", "invalid_state");
      }
      // `processOutbox` reserva la fila con `locked_until` mientras envía (fuera de esta transacción): no se toca a mitad de envío.
      if (row.locked_until !== null && (row.locked_until as Date).getTime() > clock.now().getTime()) {
        throw new ConflictError("El correo se está enviando en este momento. Vuelve a intentarlo en un minuto.", "in_flight");
      }
      await apply(connection);
      await appendSupportAction(connection, {
        supportUserId: input.supportUserId,
        action,
        targetType: "email",
        targetId: input.emailId,
        reason: input.reason.trim(),
        occurredAt: clock.now(),
      });
    });
  }

  return {
    async summary(page) {
      const [countRows] = await deps.db.execute<RowDataPacket[]>("SELECT status, COUNT(*) AS n FROM email_outbox GROUP BY status");
      const counts: Record<MailStatus, number> = { queued: 0, sent: 0, failed: 0, cancelled: 0 };
      for (const row of countRows) counts[String(row.status) as MailStatus] = Number(row.n);
      const [oldest] = await deps.db.execute<RowDataPacket[]>("SELECT MIN(created_at) AS oldest FROM email_outbox WHERE status = 'queued'");
      const offset = (page - 1) * PAGE_SIZE;
      const [failedRows] = await deps.db.execute<RowDataPacket[]>(
        `SELECT id, template, attempts, created_at, last_error_code,
                CONCAT(LEFT(to_email, 1), '***', SUBSTRING(to_email, LOCATE('@', to_email))) AS masked_to
           FROM email_outbox WHERE status = 'failed'
          ORDER BY id DESC LIMIT ${PAGE_SIZE + 1} OFFSET ${offset}`,
      );
      return {
        counts,
        oldestQueuedAt: (oldest[0]?.oldest as Date | null | undefined) ?? null,
        failed: failedRows.slice(0, PAGE_SIZE).map(
          (row): FailedMail => ({
            id: Number(row.id),
            template: String(row.template),
            maskedTo: String(row.masked_to),
            createdAt: row.created_at as Date,
            attempts: Number(row.attempts),
            errorCode: row.last_error_code === null ? null : String(row.last_error_code),
            retryable: !sensitive.has(String(row.template)),
          }),
        ),
        page,
        hasNext: failedRows.length > PAGE_SIZE,
      };
    },

    retry: (input) =>
      change(
        input,
        ["failed"],
        async (connection) => {
          await connection.execute(
            "UPDATE email_outbox SET status = 'queued', attempts = 0, next_attempt_at = ?, locked_until = NULL, last_error_code = NULL WHERE id = ?",
            [clock.now(), input.emailId],
          );
        },
        "retry_email",
      ),

    cancel: (input) =>
      change(
        input,
        ["queued", "failed"],
        async (connection) => {
          await connection.execute("UPDATE email_outbox SET status = 'cancelled', locked_until = NULL WHERE id = ?", [input.emailId]);
        },
        "cancel_email",
      ),
  };
}
