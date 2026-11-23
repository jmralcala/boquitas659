import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import type { Db } from "../../db/pool.js";
import { withTransaction } from "../../db/tx.js";
import { NotFoundError } from "../../http/errors.js";
import type { TenantContext } from "../../lib/tenant.js";

/**
 * ÚNICA vía para mutar la agenda de un médico (citas, bloqueos y configuración). Abre una transacción y bloquea la
 * fila del médico (que siempre existe: no hay bloqueo de rango vacío) antes de ejecutar `fn`, de modo que crear,
 * cancelar, bloquear, desbloquear y cambiar la configuración de un mismo médico se serializan (principio III).
 * Operaciones de médicos distintos no se bloquean entre sí. Ante un deadlock se reintenta toda la transacción, así
 * que `fn` no debe tener efectos fuera de la base de datos.
 */
export async function withCalendarLock<T>(
  ctx: TenantContext,
  db: Db,
  fn: (connection: PoolConnection) => Promise<T>,
): Promise<T> {
  return withTransaction(db, async (connection) => {
    const [rows] = await connection.execute<RowDataPacket[]>("SELECT id FROM doctor WHERE id = ? FOR UPDATE", [ctx.doctorId]);
    if (!rows[0]) throw new NotFoundError();
    return fn(connection);
  });
}
