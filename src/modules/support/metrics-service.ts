import type { RowDataPacket } from "mysql2/promise";
import type { Db } from "../../db/pool.js";
import { systemClock, type Clock } from "../../lib/clock.js";
import { DELIVERY_TARGET_PERCENT, deliveryReport } from "../../mail/delivery-report.js";
import { BOOKING_TARGET_SECONDS } from "../site/metrics-hooks.js";

export const PERIODS = ["semana", "4semanas", "piloto"] as const;
export type Period = (typeof PERIODS)[number];

/** Metas del piloto (docs/decisions/0001): finalización > 70 %, reservar < 2 min, correos entregados > 98 %, mitad de los médicos en uso. */
export const TARGETS = {
  completionPercent: 70,
  bookingSeconds: BOOKING_TARGET_SECONDS,
  deliveredPercent: DELIVERY_TARGET_PERCENT,
  sustainedUsePercent: 50,
} as const;

const DAY_MS = 86_400_000;
/** Tope de solicitudes de urgencia por cuenta cada 24 h (el mismo de la feature 4). */
const URGENT_REQUESTS_PER_DAY = 3;
const WEEK_MS = 7 * DAY_MS;

/** Porcentaje entero con un decimal, o `null` si no hay datos (nunca 0 ni división por cero). */
export function percent(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

/** Inicio (lunes 00:00 UTC) de la semana de una fecha. */
export function weekStart(date: Date): Date {
  const day = (date.getUTCDay() + 6) % 7; // lunes = 0
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day));
}

export const dateKey = (date: Date): string => date.toISOString().slice(0, 10);

/** Rango del periodo. «piloto» arranca en la primera aprobación (o 28 días atrás si aún no hay datos). */
export function periodRange(period: Period, now: Date, pilotStart: Date | null): { from: Date; to: Date } {
  if (period === "semana") return { from: new Date(now.getTime() - WEEK_MS), to: now };
  if (period === "4semanas") return { from: new Date(now.getTime() - 4 * WEEK_MS), to: now };
  return { from: pilotStart ?? new Date(now.getTime() - 4 * WEEK_MS), to: now };
}

/** Meta cumplida, no cumplida o sin datos (`null`). «más de» y «menos de» son estrictas; «al menos» incluye el valor. */
export function meets(value: number | null, target: number, direction: "above" | "below" | "atLeast"): boolean | null {
  if (value === null) return null;
  if (direction === "atLeast") return value >= target;
  return direction === "above" ? value > target : value < target;
}

export interface BookingMetrics {
  started: number;
  completed: number;
  completionPercent: number | null;
  meetsCompletion: boolean | null;
  averageSeconds: number | null;
  meetsTime: boolean | null;
  underTargetPercent: number | null;
}

export interface MetricsResult {
  period: Period;
  from: Date;
  to: Date;
  booking: BookingMetrics;
  mail: { sent: number; failed: number; deliveredPercent: number | null; meetsTarget: boolean | null };
  urgent: { scheduled: number; noSpace: number; scheduledPercent: number | null };
  /** Citas por médico y semana: solo conteos con el nombre del médico. */
  appointmentsPerDoctorWeek: Array<{ week: string; doctorId: number; doctorName: string; count: number }>;
  /** Médicos con al menos una acción de agenda en cada semana. */
  activeDoctorsPerWeek: Array<{ week: string; count: number }>;
  /**
   * Señal de abuso de urgencias AHORA (no del periodo): los límites por cuenta entre consultorios son blandos (ADR 0005), así
   * que soporte vigila cuántos pacientes tienen más de una urgencia vigente y cuántas cuentas pasaron de 3 solicitudes en 24 h.
   * Solo conteos: no se muestra quiénes son.
   */
  urgentAbuse: { patientsWithSeveralActive: number; accountsOverRequestLimit: number };
  sustainedUse: { approvedDoctors: number; activeBothWeeks: number; percent: number | null; meetsTarget: boolean | null };
  targets: typeof TARGETS;
}

export interface MetricsService {
  compute(period: Period): Promise<MetricsResult>;
}

/** Métricas del piloto: solo conteos y porcentajes, calculados al abrir la pantalla; sin datos personales ni categoría. */
export function createMetricsService(deps: { db: Db; clock?: Clock }): MetricsService {
  const clock = deps.clock ?? systemClock;

  return {
    async compute(period) {
      const now = clock.now();
      const [first] = await deps.db.execute<RowDataPacket[]>("SELECT MIN(approved_at) AS first FROM doctor WHERE approval_status = 'approved'");
      const { from, to } = periodRange(period, now, (first[0]?.first as Date | null | undefined) ?? null);

      // Reservas: contadores diarios agregados.
      const [bookingRows] = await deps.db.execute<RowDataPacket[]>(
        `SELECT COALESCE(SUM(started), 0) AS started, COALESCE(SUM(completed), 0) AS completed,
                COALESCE(SUM(duration_sum_seconds), 0) AS duration_sum, COALESCE(SUM(duration_count), 0) AS duration_count,
                COALESCE(SUM(under_target_count), 0) AS under_target
           FROM pilot_metric_daily WHERE day >= ? AND day <= ?`,
        [dateKey(from), dateKey(to)],
      );
      const b = bookingRows[0] ?? {};
      const started = Number(b.started ?? 0);
      const completed = Number(b.completed ?? 0);
      const durationCount = Number(b.duration_count ?? 0);
      // Una reserva puede completarse en otro día o periodo que su entrada: nunca se muestra más de 100 %.
      const rawCompletion = percent(completed, started);
      const completionPercent = rawCompletion === null ? null : Math.min(100, rawCompletion);
      const averageSeconds = durationCount > 0 ? Math.round(Number(b.duration_sum) / durationCount) : null;

      // Correos: el informe de entrega que ya existe.
      const delivery = await deliveryReport(deps.db, { from, to });

      // Urgencias: agendadas frente a sin espacio (nunca por categoría).
      const [urgentRows] = await deps.db.execute<RowDataPacket[]>(
        "SELECT outcome, COUNT(*) AS n FROM calendar_action_log WHERE action = 'urgent_requested' AND occurred_at >= ? AND occurred_at < ? GROUP BY outcome",
        [from, to],
      );
      const scheduled = Number(urgentRows.find((row) => row.outcome === "ok")?.n ?? 0);
      const noSpace = Number(urgentRows.find((row) => row.outcome === "rejected")?.n ?? 0);

      // Abuso de urgencias (ahora): solo cuántos, nunca quiénes. COUNT(*) va primero: soporte no lee filas de citas.
      const [activeUrgent] = await deps.db.execute<RowDataPacket[]>(
        "SELECT COUNT(*) AS n, patient_id FROM appointment WHERE kind = 'urgent' AND status = 'booked' AND start_utc > ? GROUP BY patient_id HAVING n > 1",
        [now],
      );
      const [overLimit] = await deps.db.execute<RowDataPacket[]>(
        "SELECT COUNT(*) AS n, actor_user_id FROM calendar_action_log WHERE action = 'urgent_requested' AND occurred_at > ? GROUP BY actor_user_id HAVING n > ?",
        [new Date(now.getTime() - DAY_MS), URGENT_REQUESTS_PER_DAY],
      );

      // Citas por médico y semana: SOLO se cuentan (soporte no ve quién las tiene).
      const [weekRows] = await deps.db.execute<RowDataPacket[]>(
        `SELECT COUNT(*) AS n, a.doctor_id, DATE(DATE_SUB(a.start_utc, INTERVAL WEEKDAY(a.start_utc) DAY)) AS week_start
           FROM appointment a WHERE a.status = 'booked' AND a.start_utc >= ? AND a.start_utc < ?
          GROUP BY a.doctor_id, week_start ORDER BY week_start, a.doctor_id`,
        [from, to],
      );
      const doctorIds = [...new Set(weekRows.map((row) => Number(row.doctor_id)))];
      const names = new Map<number, string>();
      if (doctorIds.length > 0) {
        const [nameRows] = await deps.db.execute<RowDataPacket[]>(`SELECT id, full_name FROM doctor WHERE id IN (${doctorIds.map(() => "?").join(",")})`, doctorIds);
        for (const row of nameRows) names.set(Number(row.id), String(row.full_name));
      }

      // Médicos activos: al menos una acción de agenda de un médico o de su recepción en la semana.
      const [activeRows] = await deps.db.execute<RowDataPacket[]>(
        `SELECT DISTINCT doctor_id, DATE(DATE_SUB(occurred_at, INTERVAL WEEKDAY(occurred_at) DAY)) AS week_start
           FROM calendar_action_log WHERE actor_role IN ('doctor','reception') AND occurred_at >= ? AND occurred_at < ?`,
        [new Date(Math.min(from.getTime(), weekStart(now).getTime() - 2 * WEEK_MS)), to],
      );
      const byWeek = new Map<string, Set<number>>();
      for (const row of activeRows) {
        const key = dateKey(row.week_start as Date);
        (byWeek.get(key) ?? byWeek.set(key, new Set()).get(key))?.add(Number(row.doctor_id));
      }
      const inRange = (key: string) => key >= dateKey(weekStart(from)) && key <= dateKey(to);
      const activeDoctorsPerWeek = [...byWeek.entries()].filter(([key]) => inRange(key)).sort(([a], [c]) => a.localeCompare(c)).map(([week, set]) => ({ week, count: set.size }));

      // Uso sostenido (criterio de salida): médicos activos en las dos últimas semanas completas, sobre los aprobados.
      const lastWeek = weekStart(new Date(now.getTime() - WEEK_MS));
      const previousWeek = new Date(lastWeek.getTime() - WEEK_MS);
      const both = [...(byWeek.get(dateKey(lastWeek)) ?? [])].filter((id) => byWeek.get(dateKey(previousWeek))?.has(id)).length;
      const [approvedRows] = await deps.db.execute<RowDataPacket[]>("SELECT COUNT(*) AS n FROM doctor WHERE approval_status = 'approved'");
      const approved = Number(approvedRows[0]?.n ?? 0);
      const sustained = percent(both, approved);

      return {
        period,
        from,
        to,
        booking: {
          started,
          completed,
          completionPercent,
          meetsCompletion: meets(completionPercent, TARGETS.completionPercent, "above"),
          averageSeconds,
          meetsTime: meets(averageSeconds, TARGETS.bookingSeconds, "below"),
          underTargetPercent: percent(Number(b.under_target ?? 0), durationCount),
        },
        mail: { sent: delivery.sent, failed: delivery.failed, deliveredPercent: delivery.deliveredPercent, meetsTarget: delivery.meetsTarget },
        urgent: { scheduled, noSpace, scheduledPercent: percent(scheduled, scheduled + noSpace) },
        appointmentsPerDoctorWeek: weekRows.map((row) => ({
          week: dateKey(row.week_start as Date),
          doctorId: Number(row.doctor_id),
          doctorName: names.get(Number(row.doctor_id)) ?? "—",
          count: Number(row.n),
        })),
        activeDoctorsPerWeek,
        urgentAbuse: { patientsWithSeveralActive: activeUrgent.length, accountsOverRequestLimit: overLimit.length },
        sustainedUse: { approvedDoctors: approved, activeBothWeeks: both, percent: sustained, meetsTarget: meets(sustained, TARGETS.sustainedUsePercent, "atLeast") },
        targets: TARGETS,
      };
    },
  };
}
