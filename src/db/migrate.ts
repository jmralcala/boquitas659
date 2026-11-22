import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import mysql from "mysql2/promise";

const LOCK_NAME = "boquitas659_migrate";
const LOCK_TIMEOUT_SECONDS = 30;
const FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;

export interface MigrationResult {
  applied: string[];
}

/**
 * Aplica los archivos `NNNN_nombre.sql` de `directory` que aún no estén en `schema_migrations`,
 * en orden numérico. Usa un candado de la base para que dos procesos no migren a la vez.
 * El DDL de MySQL/MariaDB no es transaccional: si un archivo falla a medias hay que corregirlo
 * a mano; la versión solo se registra cuando el archivo completo terminó bien.
 */
export async function runMigrations(databaseUrl: string, directory: string): Promise<MigrationResult> {
  const files = readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of files) {
    if (!FILE_PATTERN.test(name)) {
      throw new Error(`Nombre de migración inválido: ${name}`);
    }
  }

  // Conexión propia con multipleStatements: cada archivo puede traer varias sentencias.
  const connection = await mysql.createConnection({
    uri: databaseUrl,
    multipleStatements: true,
    charset: "utf8mb4",
    timezone: "Z",
  });
  const applied: string[] = [];
  try {
    const [lockRows] = await connection.query<mysql.RowDataPacket[]>("SELECT GET_LOCK(?, ?) AS ok", [
      LOCK_NAME,
      LOCK_TIMEOUT_SECONDS,
    ]);
    if (lockRows[0]?.ok !== 1) {
      throw new Error("No se pudo obtener el candado de migraciones.");
    }
    try {
      await connection.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           version VARCHAR(255) NOT NULL PRIMARY KEY,
           applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      );
      const [doneRows] = await connection.query<mysql.RowDataPacket[]>("SELECT version FROM schema_migrations");
      const done = new Set(doneRows.map((row) => String(row.version)));

      for (const name of files) {
        if (done.has(name)) continue;
        const sql = readFileSync(join(directory, name), "utf8");
        await connection.query(sql);
        await connection.query("INSERT INTO schema_migrations (version) VALUES (?)", [name]);
        applied.push(name);
      }
    } finally {
      await connection.query("SELECT RELEASE_LOCK(?)", [LOCK_NAME]);
    }
  } finally {
    await connection.end();
  }
  return { applied };
}
