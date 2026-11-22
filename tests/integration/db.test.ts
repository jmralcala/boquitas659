import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../../src/db/tx.js";
import { clearTables, createTestPool, createUser, resetDatabase } from "./helpers/db.js";

const pool = createTestPool();

beforeAll(async () => {
  await resetDatabase(pool);
});

beforeEach(async () => {
  await clearTables(pool);
});

afterAll(async () => {
  await pool.end();
});

describe("pool y transacciones", () => {
  it("las conexiones trabajan en UTC", async () => {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT @@session.time_zone AS tz, @@session.sql_mode AS mode");
    expect(rows[0]?.tz).toBe("+00:00");
    expect(String(rows[0]?.mode)).toContain("STRICT_TRANS_TABLES");
  });

  it("guarda y lee fechas sin desfase de zona horaria", async () => {
    const user = await createUser(pool);
    const instante = new Date("2026-03-01T12:34:56.789Z");
    await pool.execute("UPDATE `user` SET password_changed_at = ? WHERE id = ?", [instante, user.id]);
    const [rows] = await pool.query<RowDataPacket[]>("SELECT password_changed_at AS t FROM `user` WHERE id = ?", [user.id]);
    expect((rows[0]?.t as Date).toISOString()).toBe("2026-03-01T12:34:56.789Z");
  });

  it("confirma la transacción si todo sale bien", async () => {
    const user = await withTransaction(pool, async (connection) => {
      await connection.execute(
        "INSERT INTO `user` (email, email_normalized, role, password_hash, password_changed_at) VALUES (?, ?, 'patient', 'x', UTC_TIMESTAMP(3))",
        ["a@example.com", "a@example.com"],
      );
      return "listo";
    });
    expect(user).toBe("listo");
    const [rows] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM `user`");
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it("revierte si la función lanza", async () => {
    await expect(
      withTransaction(pool, async (connection) => {
        await connection.execute(
          "INSERT INTO `user` (email, email_normalized, role, password_hash, password_changed_at) VALUES (?, ?, 'patient', 'x', UTC_TIMESTAMP(3))",
          ["b@example.com", "b@example.com"],
        );
        throw new Error("falla a propósito");
      }),
    ).rejects.toThrow("falla a propósito");
    const [rows] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM `user`");
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it("reintenta ante un deadlock", async () => {
    let intentos = 0;
    const resultado = await withTransaction(pool, async () => {
      intentos += 1;
      if (intentos === 1) {
        const error = new Error("deadlock simulado") as Error & { errno: number };
        error.errno = 1213;
        throw error;
      }
      return "ok";
    });
    expect(resultado).toBe("ok");
    expect(intentos).toBe(2);
  });

  it("no reintenta errores que no son deadlock", async () => {
    let intentos = 0;
    await expect(
      withTransaction(pool, async () => {
        intentos += 1;
        throw new Error("otro error");
      }),
    ).rejects.toThrow("otro error");
    expect(intentos).toBe(1);
  });

  it("rechaza múltiples sentencias en una consulta (sin multipleStatements)", async () => {
    await expect(pool.query("SELECT 1; SELECT 2")).rejects.toThrow();
  });
});
