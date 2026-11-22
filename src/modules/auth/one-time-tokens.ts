import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { Db } from "../../db/pool.js";
import { systemClock, type Clock } from "../../lib/clock.js";
import { generateToken, hashToken } from "../../lib/tokens.js";

export const PASSWORD_RESET_TTL_MS = 30 * 60_000;
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60_000;
export const EMAIL_CHANGE_TTL_MS = 60 * 60_000;

export type TokenPurpose = "password_reset" | "reception_invite" | "email_change";

export interface TokenSubject {
  userId: number | null;
  invitationId: number | null;
}

type Executor = Pick<Pool, "execute"> | Pick<PoolConnection, "execute">;

export interface OneTimeTokenService {
  /**
   * Crea un token e invalida los vigentes del mismo propósito y sujeto, de modo que solo exista un
   * enlace válido por solicitud. Devuelve el token en claro una única vez; en la base solo queda su hash.
   */
  create(input: {
    purpose: TokenPurpose;
    userId?: number;
    invitationId?: number;
    ttlMs: number;
  }, executor?: Executor): Promise<{ token: string }>;
  /** Comprueba que el token es válido sin consumirlo (para pantallas que solo muestran un resumen). */
  peek(token: string, purpose: TokenPurpose): Promise<TokenSubject | null>;
  /** Consume el token de forma atómica: con peticiones simultáneas solo una lo consigue. */
  consume(token: string, purpose: TokenPurpose, executor?: Executor): Promise<TokenSubject | null>;
}

function subjectOf(row: RowDataPacket | undefined): TokenSubject | null {
  if (!row) return null;
  return {
    userId: row.user_id === null ? null : Number(row.user_id),
    invitationId: row.invitation_id === null ? null : Number(row.invitation_id),
  };
}

export function createOneTimeTokenService(db: Db, clock: Clock = systemClock): OneTimeTokenService {
  return {
    async create({ purpose, userId, invitationId, ttlMs }, executor = db) {
      const now = clock.now();
      // Invalida los tokens vigentes del mismo sujeto y propósito.
      await executor.execute(
        `UPDATE one_time_token SET used_at = ?
          WHERE purpose = ? AND used_at IS NULL AND expires_at > ?
            AND user_id <=> ? AND invitation_id <=> ?`,
        [now, purpose, now, userId ?? null, invitationId ?? null],
      );
      const token = generateToken();
      await executor.execute(
        `INSERT INTO one_time_token (token_hash, purpose, user_id, invitation_id, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [hashToken(token), purpose, userId ?? null, invitationId ?? null, new Date(now.getTime() + ttlMs), now],
      );
      return { token };
    },

    async peek(token, purpose) {
      if (token.length === 0 || token.length > 128) return null;
      const [rows] = await db.execute<RowDataPacket[]>(
        `SELECT user_id, invitation_id FROM one_time_token
          WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?`,
        [hashToken(token), purpose, clock.now()],
      );
      return subjectOf(rows[0]);
    },

    async consume(token, purpose, executor = db) {
      if (token.length === 0 || token.length > 128) return null;
      const hash = hashToken(token);
      const now = clock.now();
      const [result] = await executor.execute<ResultSetHeader>(
        `UPDATE one_time_token SET used_at = ?
          WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?`,
        [now, hash, purpose, now],
      );
      if (result.affectedRows !== 1) return null;
      const [rows] = await executor.execute<RowDataPacket[]>(
        "SELECT user_id, invitation_id FROM one_time_token WHERE token_hash = ?",
        [hash],
      );
      return subjectOf(rows[0]);
    },
  };
}
