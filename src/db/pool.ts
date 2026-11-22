import mysql, { type Pool } from "mysql2/promise";

export type Db = Pool;

// Modo estricto común a MySQL 8 y MariaDB: rechaza datos truncados y fechas inválidas en lugar de corregirlos.
const SESSION_SETUP =
  "SET time_zone = '+00:00', sql_mode = 'STRICT_TRANS_TABLES,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'";

/**
 * Pool de conexiones. Todas las consultas se escriben parametrizadas (`?`); por eso
 * `multipleStatements` queda desactivado. Las horas se guardan y leen en UTC.
 */
export function createPool(databaseUrl: string, connectionLimit = 10): Db {
  const pool = mysql.createPool({
    uri: databaseUrl,
    connectionLimit,
    waitForConnections: true,
    charset: "utf8mb4",
    timezone: "Z",
    multipleStatements: false,
    supportBigNumbers: true,
    bigNumberStrings: false,
  });
  pool.pool.on("connection", (connection) => {
    connection.query(SESSION_SETUP);
  });
  return pool;
}
