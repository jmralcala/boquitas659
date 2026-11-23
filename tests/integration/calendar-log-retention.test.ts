import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runCleanup } from "../../src/jobs/cleanup-service.js";
import { ACTION_LOG_RETENTION_DAYS } from "../../src/modules/calendar/action-log.js";
import { clearTables, createDoctor, createTestPool, resetDatabase } from "./helpers/db.js";

// Retención de 90 días del registro de acciones, sin perder su carácter de solo anexar para lo reciente.
const pool = createTestPool();
const DAY = 24 * 3_600_000;

beforeAll(async () => {
  await resetDatabase(pool);
});

beforeEach(async () => {
  await clearTables(pool);
});

afterAll(async () => {
  await pool.end();
});

async function insertLog(doctorId: number, userId: number, ageDays: number): Promise<number> {
  const [result] = await pool.execute<import("mysql2/promise").ResultSetHeader>(
    `INSERT INTO calendar_action_log (doctor_id, actor_user_id, actor_role, action, outcome, occurred_at)
     VALUES (?, ?, 'doctor', 'settings_updated', 'ok', ?)`,
    [doctorId, userId, new Date(Date.now() - ageDays * DAY)],
  );
  return result.insertId;
}

async function ids(): Promise<number[]> {
  const [rows] = await pool.query<RowDataPacket[]>("SELECT id FROM calendar_action_log ORDER BY id");
  return rows.map((row) => Number(row.id));
}

describe("retención de 90 días", () => {
  it("la retención configurada es de 90 días", () => {
    expect(ACTION_LOG_RETENTION_DAYS).toBe(90);
  });

  it("la limpieza borra lo de más de 90 días y conserva lo demás", async () => {
    const doctor = await createDoctor(pool);
    const old = await insertLog(doctor.doctorId, doctor.user.id, 120);
    const justOver = await insertLog(doctor.doctorId, doctor.user.id, 91);
    const justUnder = await insertLog(doctor.doctorId, doctor.user.id, 89);
    const recent = await insertLog(doctor.doctorId, doctor.user.id, 1);
    expect(await ids()).toEqual([old, justOver, justUnder, recent]);

    const result = await runCleanup(pool);
    expect(result.calendarLog).toBe(2);
    expect(await ids()).toEqual([justUnder, recent]);
  });

  it("es idempotente: repetirla no borra nada más", async () => {
    const doctor = await createDoctor(pool);
    await insertLog(doctor.doctorId, doctor.user.id, 200);
    await insertLog(doctor.doctorId, doctor.user.id, 5);
    expect((await runCleanup(pool)).calendarLog).toBe(1);
    expect((await runCleanup(pool)).calendarLog).toBe(0);
    expect(await ids()).toHaveLength(1);
  });

  it("sigue siendo de solo anexar: no se puede borrar nada reciente, ni actualizar nada", async () => {
    const doctor = await createDoctor(pool);
    const recent = await insertLog(doctor.doctorId, doctor.user.id, 10);
    const almost = await insertLog(doctor.doctorId, doctor.user.id, 89);
    await expect(pool.execute("DELETE FROM calendar_action_log WHERE id = ?", [recent])).rejects.toThrow(/solo anexar/);
    await expect(pool.execute("DELETE FROM calendar_action_log WHERE id = ?", [almost])).rejects.toThrow(/solo anexar/);
    await expect(pool.execute("DELETE FROM calendar_action_log")).rejects.toThrow(/solo anexar/);
    await expect(pool.execute("UPDATE calendar_action_log SET outcome = 'rejected'")).rejects.toThrow(/solo anexar/);
    expect(await ids()).toEqual([recent, almost]);
  });

  it("incluso una fila de más de 90 días no se puede modificar, solo borrar", async () => {
    const doctor = await createDoctor(pool);
    const old = await insertLog(doctor.doctorId, doctor.user.id, 100);
    await expect(pool.execute("UPDATE calendar_action_log SET outcome = 'rejected' WHERE id = ?", [old])).rejects.toThrow(/solo anexar/);
  });

  it("una sola corrida borra como máximo 10 000 filas (lo demás cae en la siguiente)", async () => {
    const doctor = await createDoctor(pool);
    const values: unknown[] = [];
    const placeholders: string[] = [];
    for (let index = 0; index < 10_050; index += 1) {
      placeholders.push("(?, ?, 'doctor', 'settings_updated', 'ok', ?)");
      values.push(doctor.doctorId, doctor.user.id, new Date(Date.now() - 100 * DAY - index));
    }
    for (let offset = 0; offset < placeholders.length; offset += 2000) {
      await pool.execute(
        `INSERT INTO calendar_action_log (doctor_id, actor_user_id, actor_role, action, outcome, occurred_at) VALUES ${placeholders.slice(offset, offset + 2000).join(", ")}`,
        values.slice(offset * 3, (offset + 2000) * 3) as never[],
      );
    }
    expect((await runCleanup(pool)).calendarLog).toBe(10_000);
    expect(await ids()).toHaveLength(50);
    expect((await runCleanup(pool)).calendarLog).toBe(50);
  });
});
