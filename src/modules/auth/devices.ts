import { createHmac } from "node:crypto";
import type { FastifyReply } from "fastify";
import type { RowDataPacket } from "mysql2/promise";
import type { Db } from "../../db/pool.js";
import { systemClock, type Clock } from "../../lib/clock.js";
import { generateToken } from "../../lib/tokens.js";

/** Cookie de dispositivo de larga vida (400 días). Contiene un identificador aleatorio, nada más. */
export const DEVICE_COOKIE = "__Host-did";
const DEVICE_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
const DEVICE_ID = /^[A-Za-z0-9_-]{43}$/;

export function setDeviceCookie(reply: FastifyReply, deviceId: string): void {
  void reply.setCookie(DEVICE_COOKIE, deviceId, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: DEVICE_COOKIE_MAX_AGE_SECONDS,
  });
}

export interface DeviceService {
  /**
   * Reconoce el dispositivo del inicio de sesión. Devuelve el identificador que debe guardarse en la cookie y si es
   * la primera vez que esta cuenta lo ve. Sin huellas del navegador ni IP: solo el identificador de la cookie.
   */
  check(userId: number, cookieValue: string | undefined): Promise<{ deviceId: string; isNew: boolean }>;
}

export function createDeviceService(db: Db, clock: Clock = systemClock, secret: string): DeviceService {
  // El hash depende de la cuenta: el mismo identificador da hashes distintos en cuentas distintas.
  const hashFor = (userId: number, deviceId: string): string =>
    createHmac("sha256", secret).update(`device:${userId}:${deviceId}`).digest("hex");

  return {
    async check(userId, cookieValue) {
      const deviceId = cookieValue !== undefined && DEVICE_ID.test(cookieValue) ? cookieValue : generateToken();
      const hash = hashFor(userId, deviceId);
      const now = clock.now();

      const [known] = await db.execute<RowDataPacket[]>(
        "SELECT id FROM trusted_device WHERE user_id = ? AND device_hash = ?",
        [userId, hash],
      );
      if (known.length > 0) {
        await db.execute("UPDATE trusted_device SET last_seen_at = ? WHERE id = ?", [now, known[0]?.id]);
        return { deviceId, isNew: false };
      }
      await db.execute(
        `INSERT INTO trusted_device (user_id, device_hash, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE last_seen_at = ?`,
        [userId, hash, now, now, now],
      );
      return { deviceId, isNew: true };
    },
  };
}
