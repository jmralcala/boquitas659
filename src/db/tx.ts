import type { Pool, PoolConnection } from "mysql2/promise";

const ER_LOCK_DEADLOCK = 1213;

function isDeadlock(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { errno?: number }).errno === ER_LOCK_DEADLOCK;
}

/**
 * Ejecuta `fn` dentro de una transacción. Confirma si termina bien y revierte si lanza.
 * Ante un deadlock reintenta toda la transacción (hasta `maxAttempts` veces), así que `fn`
 * no debe tener efectos fuera de la base de datos.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (connection: PoolConnection) => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await fn(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      if (isDeadlock(error) && attempt < maxAttempts) continue;
      throw error;
    } finally {
      connection.release();
    }
  }
}
