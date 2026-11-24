import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { TooManyAttemptsError } from "../../http/errors.js";
import type { StaffContext, TenantContext } from "../../lib/tenant.js";

type Executor = Pick<Pool, "execute"> | Pick<PoolConnection, "execute">;

export type CalendarAction =
  | "settings_updated"
  | "appointment_created"
  | "appointment_cancelled"
  | "block_created"
  | "block_removed"
  | "block_rejected"
  | "patient_lookup"
  | "site_updated"
  | "data_authorized"
  | "link_revoked";

export interface CalendarActionEntry {
  action: CalendarAction;
  outcome: "ok" | "rejected";
  appointmentId?: number;
  blockId?: number;
  at: Date;
}

/** Cuánto se conserva el registro de acciones (la limpieza periódica borra lo más antiguo; ver migración 0010). */
export const ACTION_LOG_RETENTION_DAYS = 90;

/**
 * Registra una acción sobre la agenda: quién (usuario y rol), para qué médico, qué acción, sobre qué cita o bloqueo,
 * con qué resultado y cuándo. NUNCA guarda nombres, correos ni contenido. La tabla es de solo anexar y se conserva
 * 90 días.
 */
export async function logCalendarAction(ctx: TenantContext, executor: Executor, entry: CalendarActionEntry): Promise<void> {
  await executor.execute(
    `INSERT INTO calendar_action_log (doctor_id, actor_user_id, actor_role, action, appointment_id, block_id, outcome, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [ctx.doctorId, ctx.actor.userId, ctx.actor.kind, entry.action, entry.appointmentId ?? null, entry.blockId ?? null, entry.outcome, entry.at],
  );
}

/**
 * Búsquedas de pacientes (por correo) desde un instante. `byActor` cuenta TODAS las de la persona, con cualquier médico
 * (una recepción con varios consultorios no multiplica su límite); `byDoctor` cuenta las del médico, de cualquier persona.
 */
export async function countRecentLookups(
  ctx: StaffContext,
  executor: Executor,
  since: Date,
): Promise<{ byActor: number; byDoctor: number }> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT COALESCE(SUM(doctor_id = ?), 0) AS by_doctor, COALESCE(SUM(actor_user_id = ?), 0) AS by_actor
       FROM calendar_action_log
      WHERE action = 'patient_lookup' AND occurred_at >= ? AND (doctor_id = ? OR actor_user_id = ?)`,
    [ctx.doctorId, ctx.actor.userId, since, ctx.doctorId, ctx.actor.userId],
  );
  return { byActor: Number(rows[0]?.by_actor ?? 0), byDoctor: Number(rows[0]?.by_doctor ?? 0) };
}

/** Instante de la búsqueda más antigua dentro de la ventana (de la persona, o del médico); `null` si no hay ninguna. */
export async function oldestLookupSince(
  ctx: StaffContext,
  executor: Executor,
  since: Date,
  scope: "actor" | "doctor",
): Promise<Date | null> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    scope === "actor"
      ? "SELECT MIN(occurred_at) AS oldest FROM calendar_action_log WHERE action = 'patient_lookup' AND occurred_at >= ? AND actor_user_id = ?"
      : "SELECT MIN(occurred_at) AS oldest FROM calendar_action_log WHERE action = 'patient_lookup' AND occurred_at >= ? AND doctor_id = ?",
    [since, scope === "actor" ? ctx.actor.userId : ctx.doctorId],
  );
  const oldest = rows[0]?.oldest;
  return oldest instanceof Date ? oldest : null;
}

// --- Límite de crear y cancelar citas ----------------------------------------------------------------------------------
// Cada cita creada o cancelada manda un correo a la cuenta del paciente: el límite frena el abuso (llenar de correos a una
// cuenta o a muchas) sin estorbar el uso normal de un consultorio. Los intentos rechazados no se registran, así que no cuentan.

export const ACTION_LIMITS = {
  /** Citas creadas o canceladas por persona (con cualquier médico) en una hora. */
  perActorPerHour: 60,
  /** Citas creadas por persona para un mismo paciente (con el mismo médico) en una hora. */
  perPatientPerHour: 5,
  windowMs: 60 * 60_000,
} as const;

/**
 * Lanza `TooManyAttemptsError` (429) si la persona ya llegó a su límite de acciones sobre citas en la última hora o, al
 * crear, si ya agendó demasiadas veces al mismo paciente. Se llama dentro de `withCalendarLock`, así que las ráfagas
 * simultáneas se serializan y el límite es exacto.
 */
export async function assertWithinAppointmentLimits(
  ctx: StaffContext,
  executor: Executor,
  now: Date,
  patientId: number | null,
): Promise<void> {
  const since = new Date(now.getTime() - ACTION_LIMITS.windowMs);
  const waitFrom = (oldest: unknown): number =>
    oldest instanceof Date ? oldest.getTime() + ACTION_LIMITS.windowMs - now.getTime() : ACTION_LIMITS.windowMs;

  const [byActor] = await executor.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS n, MIN(occurred_at) AS oldest FROM calendar_action_log
      WHERE actor_user_id = ? AND action IN ('appointment_created', 'appointment_cancelled') AND occurred_at >= ?`,
    [ctx.actor.userId, since],
  );
  if (Number(byActor[0]?.n ?? 0) >= ACTION_LIMITS.perActorPerHour) {
    throw new TooManyAttemptsError(Math.max(1000, waitFrom(byActor[0]?.oldest)));
  }

  if (patientId !== null) {
    const [byPatient] = await executor.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS n, MIN(l.occurred_at) AS oldest
         FROM calendar_action_log l
         JOIN appointment a ON a.id = l.appointment_id AND a.doctor_id = ?
        WHERE l.actor_user_id = ? AND l.action = 'appointment_created' AND l.occurred_at >= ? AND a.patient_id = ?`,
      [ctx.doctorId, ctx.actor.userId, since, patientId],
    );
    if (Number(byPatient[0]?.n ?? 0) >= ACTION_LIMITS.perPatientPerHour) {
      throw new TooManyAttemptsError(Math.max(1000, waitFrom(byPatient[0]?.oldest)));
    }
  }
}
