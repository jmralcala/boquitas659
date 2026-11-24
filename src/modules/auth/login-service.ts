import type { RowDataPacket } from "mysql2/promise";
import type { Db } from "../../db/pool.js";
import { withTransaction } from "../../db/tx.js";
import { systemClock, type Clock } from "../../lib/clock.js";
import { normalizeEmail } from "../../lib/normalize.js";
import { enqueueEmail } from "../../mail/outbox.js";
import type { DeviceService } from "./devices.js";
import type { LoginThrottle } from "./login-throttle.js";
import type { PasswordHasher } from "./password-hasher.js";
import { recordSecurityEvent } from "./security-events.js";
import type { SessionService, UserRole } from "./sessions.js";

export interface LoginServiceDeps {
  db: Db;
  sessions: SessionService;
  hasher: PasswordHasher;
  throttle: LoginThrottle;
  devices: DeviceService;
  clock?: Clock;
}

export interface AuthenticateInput {
  email: string;
  password: string;
  ip: string;
  /** Valor de la cookie de dispositivo, si la hay. */
  deviceCookie: string | undefined;
  /** Token de la sesión actual (se descarta al abrir la nueva: evita la fijación de sesión). */
  currentSessionToken: string | null;
  /**
   * `patient`: entrada desde un micrositio. Un correo sin cuenta de paciente (o de otro rol) se reporta como `no_account`
   * para ofrecer «Primera cita»; se acepta que esto revele si hay una cuenta de paciente, mitigado con la espera creciente.
   */
  audience?: "any" | "patient";
}

export type AuthenticateResult =
  | { kind: "throttled"; retryAfterMs: number }
  | { kind: "invalid" }
  | { kind: "no_account" }
  | { kind: "success"; sessionToken: string; deviceId: string; role: UserRole; mfaEnabled: boolean };

export interface LoginService {
  /**
   * Verifica las credenciales con la espera creciente por cuenta e IP y, si son correctas, abre una sesión nueva
   * (registrando el dispositivo nuevo y avisando por correo). El llamador solo pone las cookies y redirige.
   */
  authenticate(input: AuthenticateInput): Promise<AuthenticateResult>;
}

export function createLoginService(deps: LoginServiceDeps): LoginService {
  const clock = deps.clock ?? systemClock;

  return {
    async authenticate(input) {
      const email = normalizeEmail(input.email);
      const accountKey = deps.throttle.accountKey(input.email);

      // Espera creciente por cuenta e IP. Se aplica igual exista o no el correo, así no revela cuáles existen.
      const gate = await deps.throttle.check(accountKey, input.ip);
      if (!gate.allowed) return { kind: "throttled", retryAfterMs: gate.retryAfterMs };

      let user: RowDataPacket | undefined;
      if (email !== null) {
        const [rows] = await deps.db.execute<RowDataPacket[]>(
          "SELECT id, email, role, password_hash, status, mfa_enabled FROM `user` WHERE email_normalized = ?",
          [email],
        );
        user = rows[0];
      }
      // Desde un micrositio solo entran cuentas de paciente: otro rol se trata como si no existiera.
      const audience = input.audience ?? "any";
      if (audience === "patient" && user && user.role !== "patient") user = undefined;

      // Se hace siempre el mismo trabajo de hash, exista o no la cuenta, para no revelar cuáles correos existen.
      const passwordOk = user
        ? await deps.hasher.verify(String(user.password_hash), input.password)
        : await deps.hasher.dummyVerify(input.password);
      if (!user || !passwordOk || user.status !== "active") {
        await deps.throttle.recordFailure(accountKey, input.ip);
        return audience === "patient" && !user ? { kind: "no_account" } : { kind: "invalid" };
      }
      // Con doble factor el contador NO se reinicia aquí: si no, quien conoce la contraseña podría alternar fallos de
      // código con inicios de sesión correctos y la espera nunca crecería. Se reinicia al verificar el segundo factor.
      if (user.mfa_enabled !== 1) await deps.throttle.recordSuccess(accountKey);

      if (deps.hasher.needsRehash(String(user.password_hash))) {
        await deps.db.execute("UPDATE `user` SET password_hash = ? WHERE id = ?", [await deps.hasher.hash(input.password), user.id]);
      }

      // Dispositivo nuevo: se registra y se avisa por correo (el aviso no incluye datos más allá de la hora).
      const userId = Number(user.id);
      const device = await deps.devices.check(userId, input.deviceCookie);
      if (device.isNew) {
        await withTransaction(deps.db, async (connection) => {
          await recordSecurityEvent(connection, clock, userId, "new_device");
          await enqueueEmail(
            connection,
            { template: "new_device_login", to: String(user.email), payload: { userId, at: clock.now().toISOString() } },
            clock,
          );
        });
      }

      // Sesión nueva en cada inicio: se descarta la anterior (evita fijación de sesión).
      if (input.currentSessionToken) await deps.sessions.revoke(input.currentSessionToken);
      const { token } = await deps.sessions.create(userId, { mfaVerified: false });
      return { kind: "success", sessionToken: token, deviceId: device.deviceId, role: user.role as UserRole, mfaEnabled: user.mfa_enabled === 1 };
    },
  };
}
