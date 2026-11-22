import type { ResultSetHeader } from "mysql2/promise";
import type { Db } from "../db/pool.js";
import { systemClock, type Clock } from "../lib/clock.js";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

export interface CleanupResult {
  tokens: number;
  sessions: number;
  emails: number;
  throttle: number;
}

/**
 * Limpieza periódica (cron). Es idempotente: repetirla no borra nada más. Solo elimina lo que ya no sirve y nunca
 * toca los correos pendientes (`queued`), los registros de solo anexar ni los dispositivos conocidos.
 * - tokens de un solo uso: usados o vencidos hace más de 1 día;
 * - sesiones: revocadas o vencidas (tope absoluto) hace más de 1 día, o sin actividad desde hace más de 2 días;
 * - correos: entregados hace más de 7 días y fallidos hace más de 30;
 * - control de intentos: sin fallos desde hace más de 1 día.
 */
export async function runCleanup(db: Db, clock: Clock = systemClock): Promise<CleanupResult> {
  const now = clock.now().getTime();
  const ago = (ms: number) => new Date(now - ms);

  const [tokens] = await db.execute<ResultSetHeader>(
    "DELETE FROM one_time_token WHERE (used_at IS NOT NULL AND used_at < ?) OR expires_at < ?",
    [ago(DAY), ago(DAY)],
  );
  const [sessions] = await db.execute<ResultSetHeader>(
    "DELETE FROM session WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR absolute_expires_at < ? OR last_seen_at < ?",
    [ago(DAY), ago(DAY), ago(2 * DAY)],
  );
  const [emails] = await db.execute<ResultSetHeader>(
    "DELETE FROM email_outbox WHERE (status = 'sent' AND sent_at < ?) OR (status = 'failed' AND created_at < ?)",
    [ago(7 * DAY), ago(30 * DAY)],
  );
  const [throttle] = await db.execute<ResultSetHeader>("DELETE FROM login_throttle WHERE updated_at < ?", [ago(DAY)]);

  return {
    tokens: tokens.affectedRows,
    sessions: sessions.affectedRows,
    emails: emails.affectedRows,
    throttle: throttle.affectedRows,
  };
}
