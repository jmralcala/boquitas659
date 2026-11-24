import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import {
  clearTables,
  createCalendarSettings,
  createDoctor,
  createPatient,
  createTestPool,
  migrationsDir,
  resetDatabase,
  testDatabaseUrl,
} from "./helpers/db.js";

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

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

describe("migración 0013 (urgencias)", () => {
  it("es idempotente: repetir las migraciones no aplica nada y la 0013 está registrada", async () => {
    expect((await runMigrations(testDatabaseUrl(), migrationsDir)).applied).toEqual([]);
    expect(await rows("SELECT version FROM schema_migrations WHERE version = '0013_urgent.sql'")).toHaveLength(1);
  });

  describe("calendar_hours.kind", () => {
    it("vale `regular` por defecto, acepta `urgent` y rechaza otro valor", async () => {
      const doctor = await createDoctor(pool);
      await pool.execute("INSERT INTO calendar_hours (doctor_id, weekday, start_minute, end_minute) VALUES (?, 1, 540, 600)", [doctor.doctorId]);
      await pool.execute("INSERT INTO calendar_hours (doctor_id, weekday, start_minute, end_minute, kind) VALUES (?, 1, 480, 540, 'urgent')", [doctor.doctorId]);
      expect((await rows("SELECT kind FROM calendar_hours ORDER BY start_minute")).map((row) => row.kind)).toEqual(["urgent", "regular"]);
      await expect(
        pool.execute("INSERT INTO calendar_hours (doctor_id, weekday, start_minute, end_minute, kind) VALUES (?, 2, 480, 540, 'otro')", [doctor.doctorId]),
      ).rejects.toBeTruthy();
    });
  });

  describe("calendar_settings.urgent_min_notice_minutes", () => {
    it("vale 30 por defecto y el CHECK rechaza -1 y 1441 pero acepta 0 y 1440", async () => {
      const doctor = await createDoctor(pool);
      await createCalendarSettings(pool, doctor.doctorId);
      expect((await rows("SELECT urgent_min_notice_minutes AS n FROM calendar_settings WHERE doctor_id = ?", [doctor.doctorId]))[0]?.n).toBe(30);
      for (const [value, ok] of [[0, true], [1440, true], [1441, false], [-1, false]] as const) {
        const update = pool.execute("UPDATE calendar_settings SET urgent_min_notice_minutes = ? WHERE doctor_id = ?", [value, doctor.doctorId]);
        if (ok) await update;
        else await expect(update).rejects.toBeTruthy();
      }
    });
  });

  describe("appointment.kind", () => {
    it("acepta `urgent` y `regular` y rechaza otro valor", async () => {
      const doctor = await createDoctor(pool);
      const patient = await createPatient(pool);
      const insert = (kind: string, startHour: number) =>
        pool.execute(
          `INSERT INTO appointment (doctor_id, patient_id, start_utc, end_utc, kind, created_by_user_id, created_by_role, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'patient', UTC_TIMESTAMP(3))`,
          [doctor.doctorId, patient.patientId, new Date(Date.UTC(2026, 5, 16, startHour)), new Date(Date.UTC(2026, 5, 16, startHour, 45)), kind, patient.user.id],
        );
      await insert("urgent", 15);
      await insert("regular", 16);
      await expect(insert("otro", 17)).rejects.toBeTruthy();
      expect((await rows("SELECT kind FROM appointment ORDER BY start_utc")).map((row) => row.kind)).toEqual(["urgent", "regular"]);
    });
  });

  describe("calendar_action_log.action", () => {
    it("acepta `urgent_requested` (agendada y sin espacio) y conserva las acciones anteriores", async () => {
      const doctor = await createDoctor(pool);
      const patient = await createPatient(pool);
      const insert = (action: string, outcome: string) =>
        pool.execute(
          "INSERT INTO calendar_action_log (doctor_id, actor_user_id, actor_role, action, outcome, occurred_at) VALUES (?, ?, 'patient', ?, ?, UTC_TIMESTAMP(3))",
          [doctor.doctorId, patient.user.id, action, outcome],
        );
      await insert("urgent_requested", "ok");
      await insert("urgent_requested", "rejected");
      await insert("data_authorized", "ok");
      await insert("link_revoked", "ok");
      await expect(insert("urgencia_inventada", "ok")).rejects.toBeTruthy();
      expect(await rows("SELECT id FROM calendar_action_log WHERE action = 'urgent_requested'")).toHaveLength(2);
    });

    it("sigue siendo de solo anexar", async () => {
      const doctor = await createDoctor(pool);
      const patient = await createPatient(pool);
      await pool.execute(
        "INSERT INTO calendar_action_log (doctor_id, actor_user_id, actor_role, action, outcome, occurred_at) VALUES (?, ?, 'patient', 'urgent_requested', 'ok', UTC_TIMESTAMP(3))",
        [doctor.doctorId, patient.user.id],
      );
      await expect(pool.execute("UPDATE calendar_action_log SET outcome = 'rejected'")).rejects.toThrow(/solo anexar|90 días/);
    });
  });

  describe("privacidad (constitución I)", () => {
    it("ninguna tabla tiene una columna que guarde la categoría, el triaje ni las señales de alarma", async () => {
      const columns = await rows(
        "SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE()",
      );
      const offenders = columns.filter((column) => /categor|triage|triaje|alarm|senal|señal/i.test(String(column.c)));
      expect(offenders.map((column) => `${column.t}.${column.c}`)).toEqual([]);
    });
  });
});
