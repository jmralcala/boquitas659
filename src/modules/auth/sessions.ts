import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { Db } from "../../db/pool.js";
import { systemClock, type Clock } from "../../lib/clock.js";
import { generateToken, hashToken } from "../../lib/tokens.js";

export type UserRole = "patient" | "doctor" | "reception" | "support";

export interface SessionData {
  sessionId: number;
  userId: number;
  role: UserRole;
  activeDoctorId: number | null;
  /** El usuario tiene doble factor activo. */
  mfaEnabled: boolean;
  mfaVerified: boolean;
  csrfSecret: string;
}

export interface SessionConfig {
  /** Inactividad máxima del personal (médico, recepción, soporte). */
  staffIdleMs: number;
  /** Inactividad máxima de pacientes. */
  patientIdleMs: number;
  /** Duración máxima de una sesión aunque haya actividad. */
  absoluteMs: number;
}

export const defaultSessionConfig: SessionConfig = {
  staffIdleMs: 30 * 60_000,
  patientIdleMs: 60 * 60_000,
  absoluteMs: 12 * 60 * 60_000,
};

export interface SessionService {
  create(userId: number, options?: { mfaVerified?: boolean }): Promise<{ token: string }>;
  /** Devuelve la sesión vigente (y renueva su inactividad) o `null`. */
  validate(token: string): Promise<SessionData | null>;
  revoke(token: string): Promise<void>;
  /** Con `executor` (una conexión de transacción) el cierre ocurre dentro de ella y se revierte junto con el cambio. */
  revokeAllForUser(
    userId: number,
    exceptSessionId?: number,
    executor?: Pick<Pool, "execute"> | Pick<PoolConnection, "execute">,
  ): Promise<void>;
  /** Cambia el token (al iniciar sesión o subir de privilegio) e invalida el anterior. */
  rotate(sessionId: number, options: { mfaVerified: boolean }): Promise<{ token: string }>;
  setActiveDoctor(sessionId: number, doctorId: number | null): Promise<void>;
}

export function createSessionService(
  db: Db,
  clock: Clock = systemClock,
  config: SessionConfig = defaultSessionConfig,
): SessionService {
  return {
    async create(userId, options = {}) {
      const token = generateToken();
      const now = clock.now();
      await db.execute(
        `INSERT INTO session (token_hash, user_id, mfa_verified, csrf_secret, created_at, last_seen_at, absolute_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          hashToken(token),
          userId,
          options.mfaVerified ? 1 : 0,
          generateToken(),
          now,
          now,
          new Date(now.getTime() + config.absoluteMs),
        ],
      );
      return { token };
    },

    async validate(token) {
      if (token.length === 0 || token.length > 128) return null;
      const [rows] = await db.execute<RowDataPacket[]>(
        `SELECT s.id, s.user_id, s.active_doctor_id, s.mfa_verified, s.csrf_secret, s.last_seen_at,
                s.absolute_expires_at, s.revoked_at, u.role, u.status, u.mfa_enabled
           FROM session s
           JOIN \`user\` u ON u.id = s.user_id
          WHERE s.token_hash = ?`,
        [hashToken(token)],
      );
      const row = rows[0];
      if (!row || row.revoked_at !== null || row.status !== "active") return null;

      const now = clock.now().getTime();
      const role = row.role as UserRole;
      const idleMs = role === "patient" ? config.patientIdleMs : config.staffIdleMs;
      if (now >= (row.absolute_expires_at as Date).getTime()) return null;
      if (now - (row.last_seen_at as Date).getTime() >= idleMs) return null;

      await db.execute("UPDATE session SET last_seen_at = ? WHERE id = ?", [clock.now(), row.id]);
      return {
        sessionId: Number(row.id),
        userId: Number(row.user_id),
        role,
        activeDoctorId: row.active_doctor_id === null ? null : Number(row.active_doctor_id),
        mfaEnabled: row.mfa_enabled === 1,
        mfaVerified: row.mfa_verified === 1,
        csrfSecret: String(row.csrf_secret),
      };
    },

    async revoke(token) {
      await db.execute("UPDATE session SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL", [
        clock.now(),
        hashToken(token),
      ]);
    },

    async revokeAllForUser(userId, exceptSessionId, executor) {
      await (executor ?? db).execute(
        "UPDATE session SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id <> ?",
        [clock.now(), userId, exceptSessionId ?? 0],
      );
    },

    async rotate(sessionId, options) {
      const token = generateToken();
      const [result] = await db.execute<ResultSetHeader>(
        "UPDATE session SET token_hash = ?, mfa_verified = ?, last_seen_at = ? WHERE id = ? AND revoked_at IS NULL",
        [hashToken(token), options.mfaVerified ? 1 : 0, clock.now(), sessionId],
      );
      if (result.affectedRows !== 1) throw new Error("Sesión inexistente o revocada.");
      return { token };
    },

    async setActiveDoctor(sessionId, doctorId) {
      await db.execute("UPDATE session SET active_doctor_id = ? WHERE id = ?", [doctorId, sessionId]);
    },
  };
}
