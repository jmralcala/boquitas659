import type { Pool, PoolConnection } from "mysql2/promise";
import type { Clock } from "../../lib/clock.js";

type Executor = Pick<Pool, "execute"> | Pick<PoolConnection, "execute">;

export type SecurityEventType =
  | "new_device"
  | "password_changed"
  | "password_reset"
  | "email_change_requested"
  | "email_changed"
  | "emergency_mobile_changed"
  | "mfa_enabled"
  | "mfa_disabled";

/** Registra un evento de seguridad de la cuenta. Sin datos personales: solo quién (id), qué y cuándo. */
export async function recordSecurityEvent(
  executor: Executor,
  clock: Clock,
  userId: number,
  type: SecurityEventType,
): Promise<void> {
  await executor.execute("INSERT INTO security_event (user_id, type, occurred_at) VALUES (?, ?, ?)", [
    userId,
    type,
    clock.now(),
  ]);
}
