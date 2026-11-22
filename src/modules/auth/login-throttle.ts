import { createHmac } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import type { Db } from "../../db/pool.js";
import { systemClock, type Clock } from "../../lib/clock.js";
import { normalizeEmail } from "../../lib/normalize.js";

export interface ThrottleConfig {
  /** Espera tras el primer fallo; se duplica con cada fallo siguiente. */
  baseDelayMs: number;
  maxDelayMs: number;
  /** Fallos por IP que se toleran antes de empezar a esperar (varias personas pueden compartir una IP). */
  ipFreeAttempts: number;
  /** Tras este tiempo sin fallos el contador se olvida. */
  resetAfterMs: number;
}

export const defaultThrottleConfig: ThrottleConfig = {
  baseDelayMs: 1000,
  maxDelayMs: 15 * 60_000,
  ipFreeAttempts: 10,
  resetAfterMs: 60 * 60_000,
};

export interface LoginThrottle {
  /** Clave opaca de la cuenta (HMAC del correo normalizado): existe aunque el correo no esté registrado. */
  accountKey(email: string): string;
  check(accountKey: string, ip: string): Promise<{ allowed: boolean; retryAfterMs: number }>;
  recordFailure(accountKey: string, ip: string): Promise<void>;
  /** Reinicia el contador de la cuenta (el de la IP no se reinicia). */
  recordSuccess(accountKey: string): Promise<void>;
}

type Scope = "account" | "ip";

/**
 * Control de intentos de autenticación con espera creciente, por cuenta y por IP. El estado vive en la base
 * de datos (en hosting compartido puede haber varias instancias) y solo guarda HMAC de correo e IP.
 * No bloquea permanentemente: la espera tiene tope, para que nadie pueda dejar fuera a otra persona para siempre.
 */
export function createLoginThrottle(
  db: Db,
  clock: Clock = systemClock,
  secret: string,
  config: ThrottleConfig = defaultThrottleConfig,
): LoginThrottle {
  const ipKey = (ip: string): string => createHmac("sha256", secret).update(`throttle-ip:${ip}`).digest("hex");

  async function fail(scope: Scope, keyHash: string, freeAttempts: number): Promise<void> {
    const now = clock.now();
    // Olvida los fallos viejos antes de contar el nuevo.
    await db.execute(
      "UPDATE login_throttle SET failures = 0, locked_until = NULL WHERE scope = ? AND key_hash = ? AND updated_at < ?",
      [scope, keyHash, new Date(now.getTime() - config.resetAfterMs)],
    );
    await db.execute(
      `INSERT INTO login_throttle (scope, key_hash, failures, locked_until, updated_at) VALUES (?, ?, 1, NULL, ?)
       ON DUPLICATE KEY UPDATE failures = failures + 1, updated_at = ?`,
      [scope, keyHash, now, now],
    );
    const [rows] = await db.execute<RowDataPacket[]>(
      "SELECT failures FROM login_throttle WHERE scope = ? AND key_hash = ?",
      [scope, keyHash],
    );
    const failures = Number(rows[0]?.failures ?? 0);
    const exponent = failures - freeAttempts - 1;
    const delay = exponent >= 0 ? Math.min(config.baseDelayMs * 2 ** Math.min(exponent, 30), config.maxDelayMs) : 0;
    await db.execute("UPDATE login_throttle SET locked_until = ? WHERE scope = ? AND key_hash = ?", [
      delay > 0 ? new Date(now.getTime() + delay) : null,
      scope,
      keyHash,
    ]);
  }

  return {
    accountKey(email) {
      const normalized = normalizeEmail(email) ?? email.trim().toLowerCase();
      return createHmac("sha256", secret).update(`throttle-account:${normalized}`).digest("hex");
    },

    async check(accountKey, ip) {
      const now = clock.now().getTime();
      const [rows] = await db.execute<RowDataPacket[]>(
        `SELECT locked_until, updated_at FROM login_throttle
          WHERE (scope = 'account' AND key_hash = ?) OR (scope = 'ip' AND key_hash = ?)`,
        [accountKey, ipKey(ip)],
      );
      let retryAfterMs = 0;
      for (const row of rows) {
        if (row.locked_until === null) continue;
        if (now - (row.updated_at as Date).getTime() >= config.resetAfterMs) continue;
        retryAfterMs = Math.max(retryAfterMs, (row.locked_until as Date).getTime() - now);
      }
      return retryAfterMs > 0 ? { allowed: false, retryAfterMs } : { allowed: true, retryAfterMs: 0 };
    },

    async recordFailure(accountKey, ip) {
      await fail("account", accountKey, 0);
      await fail("ip", ipKey(ip), config.ipFreeAttempts);
    },

    async recordSuccess(accountKey) {
      await db.execute("DELETE FROM login_throttle WHERE scope = 'account' AND key_hash = ?", [accountKey]);
    },
  };
}
