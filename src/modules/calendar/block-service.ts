import type { PoolConnection } from "mysql2/promise";
import type { Db } from "../../db/pool.js";
import { AppError, NotFoundError, ValidationError } from "../../http/errors.js";
import type { Clock } from "../../lib/clock.js";
import type { StaffContext } from "../../lib/tenant.js";
import { daysBetweenLocalDates, localToUtc, utcToLocal } from "../../lib/zoned-time.js";
import { logCalendarAction } from "./action-log.js";
import { MAX_DAYS_AHEAD, MAX_DAYS_BACK } from "./agenda-service.js";
import { parseLocalStart, resolveSlot } from "./appointment-service.js";
import { deleteBlock, findConflictingAppointments, insertBlock, type ConflictingAppointment } from "./block-repository.js";
import { withCalendarLock } from "./calendar-lock.js";
import { loadSettings } from "./settings-repository.js";

/** Un bloqueo dura como máximo 366 días y su motivo, 200 caracteres (data-model.md). */
export const MAX_BLOCK_DAYS = 366;
export const MAX_REASON_LENGTH = 200;

export interface BlockDeps {
  db: Db;
  clock: Clock;
}

export interface CreateBlockInput {
  /** Inicio y fin del bloqueo en hora local del consultorio: `AAAA-MM-DDTHH:MM`. */
  fromLocal: string;
  toLocal: string;
  reason?: string | undefined;
}

/**
 * Se intentó bloquear un horario que incluye citas: no se bloquea NADA y se informa cuáles son (hasta 50 y el total).
 * Hay que cancelarlas primero (con aviso al paciente) y volver a intentar.
 */
export class BlockConflictError extends AppError {
  constructor(
    readonly appointments: readonly ConflictingAppointment[],
    readonly total: number,
  ) {
    super(409, "appointments_in_range", "Ese horario incluye citas. Cancélalas primero y vuelve a intentar.");
    this.name = "BlockConflictError";
  }
}

type Outcome = { kind: "ok"; id: number } | { kind: "conflict"; appointments: ConflictingAppointment[]; total: number };

/**
 * Bloquea [desde, hasta) bajo el bloqueo del médico. `resolveRange` valida y convierte el rango dentro de la transacción
 * (necesita la zona del consultorio). Si el rango incluye citas vigentes que aún no terminan, NO inserta nada: registra
 * `block_rejected` (la transacción lo confirma) y la excepción con la lista se lanza después, ya confirmada la transacción.
 */
async function blockWithin(
  ctx: StaffContext,
  deps: BlockDeps,
  reason: string | null,
  resolveRange: (connection: PoolConnection, now: Date) => Promise<{ fromUtc: Date; toUtc: Date }>,
): Promise<{ id: number }> {
  if (reason !== null && reason.length > MAX_REASON_LENGTH) {
    throw new ValidationError({ motivo: [`El motivo admite hasta ${MAX_REASON_LENGTH} caracteres.`] });
  }
  const outcome = await withCalendarLock<Outcome>(ctx, deps.db, async (connection) => {
    const now = deps.clock.now();
    const { fromUtc, toUtc } = await resolveRange(connection, now);
    const conflicts = await findConflictingAppointments(ctx, connection, fromUtc, toUtc, now);
    if (conflicts.total > 0) {
      await logCalendarAction(ctx, connection, { action: "block_rejected", outcome: "rejected", at: now });
      return { kind: "conflict", appointments: conflicts.appointments, total: conflicts.total };
    }
    const id = await insertBlock(ctx, connection, { startUtc: fromUtc, endUtc: toUtc, reason, now });
    await logCalendarAction(ctx, connection, { action: "block_created", outcome: "ok", blockId: id, at: now });
    return { kind: "ok", id };
  });
  if (outcome.kind === "conflict") throw new BlockConflictError(outcome.appointments, outcome.total);
  return { id: outcome.id };
}

function toUtcOrFail(zone: string, value: string, field: "desde" | "hasta"): Date {
  const parsed = parseLocalStart(value);
  if (!parsed) throw new ValidationError({ [field]: ["Elige una fecha y hora válidas."] });
  const instant = localToUtc(zone, parsed.date, parsed.minutes);
  if (!instant) throw new ValidationError({ [field]: ["Esa hora no existe ese día (cambio de horario)."] });
  return instant;
}

/** Bloquea un rango de fecha y hora (también de varios días). Rechazo total si incluye citas vigentes. */
export async function createBlock(ctx: StaffContext, deps: BlockDeps, input: CreateBlockInput): Promise<{ id: number }> {
  const reason = input.reason && input.reason.trim() !== "" ? input.reason.trim() : null;
  return blockWithin(ctx, deps, reason, async (connection, now) => {
    const { settings } = await loadSettings(ctx, connection);
    const fromUtc = toUtcOrFail(settings.timezone, input.fromLocal, "desde");
    const toUtc = toUtcOrFail(settings.timezone, input.toLocal, "hasta");
    const today = utcToLocal(settings.timezone, now).date;
    const fromDate = parseLocalStart(input.fromLocal)?.date ?? today;
    const toDate = parseLocalStart(input.toLocal)?.date ?? today;
    if (daysBetweenLocalDates(today, fromDate) > MAX_DAYS_AHEAD || daysBetweenLocalDates(today, toDate) > MAX_DAYS_AHEAD) {
      throw new ValidationError({ hasta: [`Solo se puede bloquear hasta ${MAX_DAYS_AHEAD} días hacia adelante.`] });
    }
    if (daysBetweenLocalDates(today, fromDate) < -MAX_DAYS_BACK) {
      throw new ValidationError({ desde: [`El inicio no puede ser anterior a ${MAX_DAYS_BACK} días atrás.`] });
    }
    if (toUtc.getTime() <= fromUtc.getTime()) throw new ValidationError({ hasta: ["El fin debe ser posterior al inicio."] });
    if (toUtc.getTime() <= now.getTime()) throw new ValidationError({ hasta: ["El bloqueo no puede terminar en el pasado."] });
    if (toUtc.getTime() - fromUtc.getTime() > MAX_BLOCK_DAYS * 86_400_000) {
      throw new ValidationError({ hasta: [`Un bloqueo dura como máximo ${MAX_BLOCK_DAYS} días.`] });
    }
    return { fromUtc, toUtc };
  });
}

/** Atajo desde la agenda: bloquea exactamente el rango de un espacio. */
export async function blockSlot(ctx: StaffContext, deps: BlockDeps, startLocal: string): Promise<{ id: number }> {
  return blockWithin(ctx, deps, null, async (connection, now) => {
    const { slot } = await resolveSlot(ctx, connection, startLocal, now);
    if (slot.endUtc.getTime() <= now.getTime()) throw new ValidationError({ inicio: ["Ese espacio ya terminó."] });
    return { fromUtc: slot.startUtc, toUtc: slot.endUtc };
  });
}

/** Desbloquea: borra el bloqueo completo (la constancia queda en el registro de acciones). */
export async function removeBlock(ctx: StaffContext, deps: BlockDeps, id: number): Promise<void> {
  await withCalendarLock(ctx, deps.db, async (connection) => {
    if (!(await deleteBlock(ctx, connection, id))) throw new NotFoundError();
    await logCalendarAction(ctx, connection, { action: "block_removed", outcome: "ok", blockId: id, at: deps.clock.now() });
  });
}
