import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { z } from "zod";

type Executor = Pick<Pool, "execute"> | Pick<PoolConnection, "execute">;

export const SUPPORT_ACTIONS = [
  "approve",
  "reject",
  "release_cedula",
  "suspend",
  "read_only",
  "reactivate",
  "change_slug",
  "retry_email",
  "cancel_email",
  "view_cedula",
  "view_identificacion",
] as const;
export type SupportAction = (typeof SUPPORT_ACTIONS)[number];
export type SupportTarget = "doctor" | "site" | "email";

export interface SupportActionEntry {
  supportUserId: number;
  action: SupportAction;
  targetType: SupportTarget;
  targetId: number;
  /** Motivo interno (nunca contenido de mensajes ni datos de pacientes). Nulo solo en consultas sin motivo. */
  reason: string | null;
  occurredAt: Date;
}

export interface SupportActionRow extends SupportActionEntry {
  id: number;
  supportEmail: string;
}

/**
 * Anexa una entrada al historial. Debe llamarse con la conexión de la MISMA transacción que hace el cambio, de modo que
 * no exista un cambio sin su entrada ni una entrada sin su cambio. La tabla es de solo anexar: no hay forma de editar ni borrar.
 */
export async function appendSupportAction(executor: Executor, entry: SupportActionEntry): Promise<void> {
  await executor.execute(
    `INSERT INTO support_action_log (support_user_id, action, target_type, target_id, reason, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [entry.supportUserId, entry.action, entry.targetType, entry.targetId, entry.reason, entry.occurredAt],
  );
}

export const PAGE_SIZE = 50;

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida (AAAA-MM-DD).")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "Fecha inválida (AAAA-MM-DD).");

/** Filtros de la lista. Todos opcionales; `desde` y `hasta` incluyen el día completo (UTC). */
export const historyFilters = z
  .object({
    pagina: z.coerce.number({ error: "Página inválida." }).int("Página inválida.").min(1, "Página inválida.").max(100_000, "Página inválida.").default(1),
    persona: z.coerce.number({ error: "Persona inválida." }).int("Persona inválida.").positive("Persona inválida.").optional(),
    accion: z.enum(SUPPORT_ACTIONS, { error: "Acción inválida." }).optional(),
    objetivo: z.coerce.number({ error: "Objetivo inválido." }).int("Objetivo inválido.").positive("Objetivo inválido.").optional(),
    desde: dateOnly.optional(),
    hasta: dateOnly.optional(),
  })
  .refine((value) => value.desde === undefined || value.hasta === undefined || value.desde <= value.hasta, {
    message: "«Desde» no puede ser posterior a «hasta».",
    path: ["desde"],
  });
export type HistoryFilters = z.infer<typeof historyFilters>;

export interface HistoryPage {
  rows: SupportActionRow[];
  page: number;
  hasNext: boolean;
}

/** Entradas de la más reciente a la más antigua, 50 por página, con filtros opcionales. Solo lectura. */
export async function listSupportActions(executor: Executor, filters: HistoryFilters): Promise<HistoryPage> {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filters.persona !== undefined) {
    where.push("l.support_user_id = ?");
    params.push(filters.persona);
  }
  if (filters.accion !== undefined) {
    where.push("l.action = ?");
    params.push(filters.accion);
  }
  if (filters.objetivo !== undefined) {
    where.push("l.target_type IN ('doctor', 'site') AND l.target_id = ?");
    params.push(filters.objetivo);
  }
  if (filters.desde !== undefined) {
    where.push("l.occurred_at >= ?");
    params.push(`${filters.desde} 00:00:00.000`);
  }
  if (filters.hasta !== undefined) {
    where.push("l.occurred_at < DATE_ADD(?, INTERVAL 1 DAY)");
    params.push(`${filters.hasta} 00:00:00.000`);
  }
  const offset = (filters.pagina - 1) * PAGE_SIZE;
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT l.id, l.support_user_id, u.email AS support_email, l.action, l.target_type, l.target_id, l.reason, l.occurred_at
       FROM support_action_log l JOIN \`user\` u ON u.id = l.support_user_id
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY l.occurred_at DESC, l.id DESC
      LIMIT ${PAGE_SIZE + 1} OFFSET ${offset}`,
    params,
  );
  const items = rows.slice(0, PAGE_SIZE).map(
    (row): SupportActionRow => ({
      id: Number(row.id),
      supportUserId: Number(row.support_user_id),
      supportEmail: String(row.support_email),
      action: row.action as SupportAction,
      targetType: row.target_type as SupportTarget,
      targetId: Number(row.target_id),
      reason: row.reason === null ? null : String(row.reason),
      occurredAt: row.occurred_at as Date,
    }),
  );
  return { rows: items, page: filters.pagina, hasNext: rows.length > PAGE_SIZE };
}
