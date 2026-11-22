import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt } from "node:crypto";
import { generateSecret, generateURI, verify } from "otplib";
import type { Db } from "../../db/pool.js";
import { withTransaction } from "../../db/tx.js";
import { AppError } from "../../http/errors.js";
import { systemClock, type Clock } from "../../lib/clock.js";

// --- Cifrado del secreto TOTP en reposo (AES-256-GCM) ---------------------------------------------------------

function keyBytes(keyHex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) throw new Error("La clave de cifrado debe ser de 32 bytes en hexadecimal.");
  return Buffer.from(keyHex, "hex");
}

/** `v1:` + base64url(iv ‖ etiqueta de autenticación ‖ texto cifrado). El IV es aleatorio en cada cifrado. */
export function encryptSecret(plain: string, keyHex: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(keyHex), iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url")}`;
}

/** Lanza si el texto fue manipulado, la clave es otra o el formato no es válido. */
export function decryptSecret(stored: string, keyHex: string): string {
  if (!stored.startsWith("v1:")) throw new Error("Formato de secreto desconocido.");
  const raw = Buffer.from(stored.slice(3), "base64url");
  if (raw.length < 12 + 16 + 1) throw new Error("Secreto cifrado inválido.");
  const decipher = createDecipheriv("aes-256-gcm", keyBytes(keyHex), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

// --- Verificación TOTP ------------------------------------------------------------------------------------

export type TotpResult = { valid: true; timeStep: number } | { valid: false };

/**
 * Verifica un código de 6 dígitos con tolerancia de ±30 s. `afterTimeStep` rechaza cualquier código de un paso de
 * tiempo igual o anterior al último aceptado, de modo que un código no se puede reutilizar.
 */
export async function verifyTotpCode(input: {
  secret: string;
  token: string;
  nowMs: number;
  afterTimeStep?: number;
}): Promise<TotpResult> {
  if (!/^\d{6}$/.test(input.token)) return { valid: false };
  const result = await verify({
    secret: input.secret,
    token: input.token,
    epoch: input.nowMs / 1000,
    epochTolerance: 30,
    ...(input.afterTimeStep === undefined ? {} : { afterTimeStep: input.afterTimeStep }),
  });
  if (!result.valid) return { valid: false };
  // Se usa el paso que devuelve la biblioteca; si su tipo no lo expone, es el paso actual más el desfase (`delta`).
  const delta = "delta" in result && typeof result.delta === "number" ? result.delta : 0;
  const timeStep = "timeStep" in result && typeof result.timeStep === "number" ? result.timeStep : Math.floor(input.nowMs / 1000 / 30) + delta;
  return { valid: true, timeStep };
}

// --- Códigos de recuperación -------------------------------------------------------------------------------

// Sin caracteres ambiguos (i, l, o, 0, 1): se leen y se teclean sin errores.
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const RECOVERY_CODE_COUNT = 10;

function randomChunk(length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** 10 códigos únicos con formato `xxxxx-xxxxx` (≈50 bits cada uno). */
export function generateRecoveryCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < RECOVERY_CODE_COUNT) codes.add(`${randomChunk(5)}-${randomChunk(5)}`);
  return [...codes];
}

export function normalizeRecoveryCode(input: string): string {
  return input.toLowerCase().replace(/[\s-]/g, "");
}

/** HMAC con la clave de la aplicación: una filtración de la base de datos por sí sola no permite probar códigos. */
export function hashRecoveryCode(code: string, keyHex: string): string {
  return createHmac("sha256", keyBytes(keyHex)).update(`recovery:${normalizeRecoveryCode(code)}`).digest("hex");
}

// --- Servicio ---------------------------------------------------------------------------------------------

const ISSUER = "Agenda Dental";

export interface MfaService {
  /** Genera un secreto nuevo (cifrado, aún sin activar). Falla con 409 si el doble factor ya está activo. */
  beginEnrollment(userId: number): Promise<{ secret: string; otpauthUri: string }>;
  /** Alta pendiente (para volver a mostrar el secreto tras un código erróneo), o `null`. */
  pendingEnrollment(userId: number): Promise<{ secret: string; otpauthUri: string } | null>;
  /** Activa con un código correcto y devuelve los códigos de recuperación (una sola vez); `null` si el código no vale. */
  confirmEnrollment(
    userId: number,
    code: string,
    onActivated?: (connection: import("mysql2/promise").PoolConnection) => Promise<void>,
  ): Promise<{ recoveryCodes: string[] } | null>;
  /** Código TOTP o de recuperación del inicio de sesión. Cada uno solo sirve una vez. */
  verifyLogin(userId: number, code: string): Promise<boolean>;
  disable(userId: number, onDisabled?: (connection: import("mysql2/promise").PoolConnection) => Promise<void>): Promise<void>;
  isEnabled(userId: number): Promise<boolean>;
}

export function createMfaService(db: Db, clock: Clock = systemClock, keyHex: string): MfaService {
  async function loadUser(userId: number): Promise<{ email: string; enabled: boolean; secret: string | null; lastStep: number | null }> {
    const [rows] = await db.execute<import("mysql2/promise").RowDataPacket[]>(
      "SELECT email, mfa_enabled, mfa_secret_encrypted, mfa_last_time_step FROM `user` WHERE id = ?",
      [userId],
    );
    const row = rows[0];
    if (!row) throw new AppError(404, "not_found", "No encontramos lo que buscas.");
    return {
      email: String(row.email),
      enabled: row.mfa_enabled === 1,
      secret: row.mfa_secret_encrypted === null ? null : decryptSecret(String(row.mfa_secret_encrypted), keyHex),
      lastStep: row.mfa_last_time_step === null ? null : Number(row.mfa_last_time_step),
    };
  }

  const describe = (email: string, secret: string) => ({
    secret,
    otpauthUri: generateURI({ issuer: ISSUER, label: email, secret }),
  });

  return {
    async beginEnrollment(userId) {
      const user = await loadUser(userId);
      if (user.enabled) throw new AppError(409, "mfa_already_enabled", "El doble factor ya está activo.");
      const secret = generateSecret();
      // Condicionado a `mfa_enabled = 0`: si otra petición lo activó entre tanto, no se desactiva por accidente.
      const [update] = await db.execute<import("mysql2/promise").ResultSetHeader>(
        "UPDATE `user` SET mfa_secret_encrypted = ?, mfa_enabled = 0, mfa_last_time_step = NULL WHERE id = ? AND mfa_enabled = 0",
        [encryptSecret(secret, keyHex), userId],
      );
      if (update.affectedRows !== 1) throw new AppError(409, "mfa_already_enabled", "El doble factor ya está activo.");
      return describe(user.email, secret);
    },

    async pendingEnrollment(userId) {
      const user = await loadUser(userId);
      return !user.enabled && user.secret ? describe(user.email, user.secret) : null;
    },

    async confirmEnrollment(userId, code, onActivated) {
      const user = await loadUser(userId);
      if (user.enabled) throw new AppError(409, "mfa_already_enabled", "El doble factor ya está activo.");
      if (!user.secret) return null;
      const result = await verifyTotpCode({ secret: user.secret, token: code.trim(), nowMs: clock.now().getTime() });
      if (!result.valid) return null;

      const recoveryCodes = generateRecoveryCodes();
      await withTransaction(db, async (connection) => {
        await connection.execute("UPDATE `user` SET mfa_enabled = 1, mfa_last_time_step = ? WHERE id = ?", [result.timeStep, userId]);
        await connection.execute("DELETE FROM mfa_recovery_code WHERE user_id = ?", [userId]);
        for (const recovery of recoveryCodes) {
          await connection.execute("INSERT INTO mfa_recovery_code (user_id, code_hash, created_at) VALUES (?, ?, ?)", [
            userId,
            hashRecoveryCode(recovery, keyHex),
            clock.now(),
          ]);
        }
        // El evento de seguridad y el aviso por correo van en la misma transacción que el cambio.
        if (onActivated) await onActivated(connection);
      });
      return { recoveryCodes };
    },

    async verifyLogin(userId, rawCode) {
      const user = await loadUser(userId);
      if (!user.enabled || !user.secret) return false;
      const code = rawCode.trim();

      if (/^\d{6}$/.test(code)) {
        const result = await verifyTotpCode({
          secret: user.secret,
          token: code,
          nowMs: clock.now().getTime(),
          ...(user.lastStep === null ? {} : { afterTimeStep: user.lastStep }),
        });
        if (!result.valid) return false;
        // Actualización condicional: con dos envíos simultáneos del mismo código solo uno lo consume.
        const [update] = await db.execute<import("mysql2/promise").ResultSetHeader>(
          "UPDATE `user` SET mfa_last_time_step = ? WHERE id = ? AND (mfa_last_time_step IS NULL OR mfa_last_time_step < ?)",
          [result.timeStep, userId, result.timeStep],
        );
        return update.affectedRows === 1;
      }

      // Código de recuperación: se compara su HMAC por igualdad en la base de datos (no se comparan secretos en
      // claro) y se marca como usado de forma atómica.
      const normalized = normalizeRecoveryCode(code);
      if (!/^[a-z0-9]{10}$/.test(normalized)) return false;
      const [update] = await db.execute<import("mysql2/promise").ResultSetHeader>(
        "UPDATE mfa_recovery_code SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL",
        [clock.now(), userId, hashRecoveryCode(normalized, keyHex)],
      );
      return update.affectedRows === 1;
    },

    async disable(userId, onDisabled) {
      await withTransaction(db, async (connection) => {
        await connection.execute(
          "UPDATE `user` SET mfa_enabled = 0, mfa_secret_encrypted = NULL, mfa_last_time_step = NULL WHERE id = ?",
          [userId],
        );
        await connection.execute("DELETE FROM mfa_recovery_code WHERE user_id = ?", [userId]);
        if (onDisabled) await onDisabled(connection);
      });
    },

    async isEnabled(userId) {
      return (await loadUser(userId)).enabled;
    },
  };
}
