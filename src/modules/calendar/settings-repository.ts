import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import type { Db } from "../../db/pool.js";
import { ForbiddenError } from "../../http/errors.js";
import type { HoursRange } from "../../lib/calendar-slots.js";
import type { Clock } from "../../lib/clock.js";
import type { TenantContext } from "../../lib/tenant.js";
import { logCalendarAction } from "./action-log.js";
import { withCalendarLock } from "./calendar-lock.js";
import { DEFAULT_SETTINGS, type CalendarConfig, type CalendarInput } from "./settings.js";

type Executor = Pick<Pool, "execute"> | Pick<PoolConnection, "execute">;

/** Configuración y franjas del médico del contexto; si no ha guardado nada, los valores por defecto y sin franjas. */
export async function loadSettings(ctx: TenantContext, executor: Executor): Promise<CalendarConfig> {
  const [settingsRows] = await executor.execute<RowDataPacket[]>(
    `SELECT slot_minutes, gap_minutes, timezone, min_notice_minutes, max_advance_days
       FROM calendar_settings WHERE doctor_id = ?`,
    [ctx.doctorId],
  );
  const [hourRows] = await executor.execute<RowDataPacket[]>(
    "SELECT weekday, start_minute, end_minute FROM calendar_hours WHERE doctor_id = ? ORDER BY weekday, start_minute",
    [ctx.doctorId],
  );
  const hours: HoursRange[] = hourRows.map((row) => ({
    weekday: Number(row.weekday),
    startMinute: Number(row.start_minute),
    endMinute: Number(row.end_minute),
  }));
  const row = settingsRows[0];
  if (!row) return { settings: { ...DEFAULT_SETTINGS }, hours, isDefault: true };
  return {
    settings: {
      slotMinutes: Number(row.slot_minutes),
      gapMinutes: Number(row.gap_minutes),
      timezone: String(row.timezone),
      minNoticeMinutes: Number(row.min_notice_minutes),
      maxAdvanceDays: Number(row.max_advance_days),
    },
    hours,
    isDefault: false,
  };
}

/**
 * Guarda la configuración y REEMPLAZA todas las franjas, en una sola transacción con el bloqueo del médico (si algo
 * falla no cambia nada). Solo el médico configura; recepción recibe 403. NUNCA toca citas ni bloqueos existentes: los
 * espacios se calculan al leer, así que el cambio solo afecta a los espacios y a las reservas nuevas.
 */
export async function saveSettings(ctx: TenantContext, db: Db, input: CalendarInput, clock: Clock): Promise<void> {
  if (ctx.actor.kind !== "doctor") throw new ForbiddenError();
  await withCalendarLock(ctx, db, async (connection) => {
    const now = clock.now();
    const { settings } = input;
    await connection.execute(
      `INSERT INTO calendar_settings (doctor_id, slot_minutes, gap_minutes, timezone, min_notice_minutes, max_advance_days, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE slot_minutes = VALUES(slot_minutes), gap_minutes = VALUES(gap_minutes), timezone = VALUES(timezone),
         min_notice_minutes = VALUES(min_notice_minutes), max_advance_days = VALUES(max_advance_days), updated_at = VALUES(updated_at)`,
      [ctx.doctorId, settings.slotMinutes, settings.gapMinutes, settings.timezone, settings.minNoticeMinutes, settings.maxAdvanceDays, now],
    );
    await connection.execute("DELETE FROM calendar_hours WHERE doctor_id = ?", [ctx.doctorId]);
    for (const range of input.hours) {
      await connection.execute("INSERT INTO calendar_hours (doctor_id, weekday, start_minute, end_minute) VALUES (?, ?, ?, ?)", [
        ctx.doctorId,
        range.weekday,
        range.startMinute,
        range.endMinute,
      ]);
    }
    await logCalendarAction(ctx, connection, { action: "settings_updated", outcome: "ok", at: now });
  });
}
