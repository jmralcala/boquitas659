import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import { createTestPool, dropAllTables, migrationsDir, testDatabaseUrl } from "./helpers/db.js";

const pool = createTestPool();

beforeEach(async () => {
  await dropAllTables(pool);
});

afterAll(async () => {
  await dropAllTables(pool);
  await pool.end();
});

async function tableNames(): Promise<string[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name",
  );
  return rows.map((row) => String(row.name));
}

describe("runMigrations", () => {
  it("aplica las migraciones sobre una base vacía y registra las versiones", async () => {
    const { applied } = await runMigrations(testDatabaseUrl(), migrationsDir);
    expect(applied.length).toBeGreaterThan(0);
    expect(applied[0]).toBe("0001_core.sql");

    const tables = await tableNames();
    expect(tables).toEqual(expect.arrayContaining(["user", "session", "one_time_token", "consent_acceptance", "schema_migrations"]));

    const [rows] = await pool.query<RowDataPacket[]>("SELECT version FROM schema_migrations ORDER BY version");
    expect(rows.map((row) => row.version)).toEqual(applied);
  });

  it("es idempotente: repetirlo no aplica nada", async () => {
    await runMigrations(testDatabaseUrl(), migrationsDir);
    const second = await runMigrations(testDatabaseUrl(), migrationsDir);
    expect(second.applied).toEqual([]);
  });

  it("dos ejecuciones simultáneas no duplican ni fallan (candado)", async () => {
    const [a, b] = await Promise.all([
      runMigrations(testDatabaseUrl(), migrationsDir),
      runMigrations(testDatabaseUrl(), migrationsDir),
    ]);
    expect(a.applied.length + b.applied.length).toBe(
      Math.max(a.applied.length, b.applied.length),
    );
    const [rows] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM schema_migrations");
    expect(Number(rows[0]?.n)).toBe(Math.max(a.applied.length, b.applied.length));
  });

  it("aplica en orden numérico y se detiene en el primer error sin registrar el archivo fallido", async () => {
    const dir = mkdtempSync(join(tmpdir(), "migraciones-"));
    try {
      writeFileSync(join(dir, "0001_uno.sql"), "CREATE TABLE t_uno (id INT PRIMARY KEY);");
      writeFileSync(join(dir, "0002_malo.sql"), "CREATE TABLE t_malo (id INT PRIMARY KEY); SELECT * FROM no_existe;");
      writeFileSync(join(dir, "0003_tres.sql"), "CREATE TABLE t_tres (id INT PRIMARY KEY);");

      await expect(runMigrations(testDatabaseUrl(), dir)).rejects.toThrow();

      const [rows] = await pool.query<RowDataPacket[]>("SELECT version FROM schema_migrations");
      expect(rows.map((row) => row.version)).toEqual(["0001_uno.sql"]);
      expect(await tableNames()).not.toContain("t_tres");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rechaza nombres de archivo que no siguen NNNN_nombre.sql", async () => {
    const dir = mkdtempSync(join(tmpdir(), "migraciones-"));
    try {
      writeFileSync(join(dir, "uno.sql"), "SELECT 1;");
      await expect(runMigrations(testDatabaseUrl(), dir)).rejects.toThrow(/inválido/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("los disparadores de solo anexar existen tras migrar", async () => {
    await runMigrations(testDatabaseUrl(), migrationsDir);
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT trigger_name AS name FROM information_schema.triggers WHERE trigger_schema = DATABASE() ORDER BY trigger_name",
    );
    expect(rows.map((row) => row.name)).toEqual([
      "calendar_action_log_no_delete",
      "calendar_action_log_no_update",
      "consent_acceptance_no_delete",
      "consent_acceptance_no_update",
      "data_authorization_no_delete",
      "data_authorization_no_update",
      "patient_access_log_no_delete",
      "patient_access_log_no_update",
    ]);
  });
});
