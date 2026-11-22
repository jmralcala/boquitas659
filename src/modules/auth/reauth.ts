import type { RowDataPacket } from "mysql2/promise";
import type { Db } from "../../db/pool.js";
import { ForbiddenError, TooManyAttemptsError, WrongPasswordError } from "../../http/errors.js";
import type { LoginThrottle } from "./login-throttle.js";
import type { PasswordHasher } from "./password-hasher.js";

export interface ConfirmedUser {
  id: number;
  email: string;
  role: string;
}

export interface Reauth {
  /**
   * Confirma la contraseña actual antes de un cambio sensible. Comparte el control de intentos del inicio de sesión:
   * una contraseña incorrecta cuenta como intento fallido y las repeticiones inmediatas reciben 429.
   */
  confirm(userId: number, ip: string, currentPassword: string): Promise<ConfirmedUser>;
}

export function createReauth(db: Db, hasher: PasswordHasher, throttle: LoginThrottle): Reauth {
  return {
    async confirm(userId, ip, currentPassword) {
      const [rows] = await db.execute<RowDataPacket[]>(
        "SELECT id, email, role, password_hash, status FROM `user` WHERE id = ?",
        [userId],
      );
      const user = rows[0];
      if (!user || user.status !== "active") throw new ForbiddenError();

      const key = throttle.accountKey(String(user.email));
      const gate = await throttle.check(key, ip);
      if (!gate.allowed) throw new TooManyAttemptsError(gate.retryAfterMs);

      if (!(await hasher.verify(String(user.password_hash), currentPassword))) {
        await throttle.recordFailure(key, ip);
        throw new WrongPasswordError();
      }
      await throttle.recordSuccess(key);
      return { id: Number(user.id), email: String(user.email), role: String(user.role) };
    },
  };
}
