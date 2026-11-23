import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import { clearTables, createDoctor, createPatient, createTestPool, migrationsDir, resetDatabase, testDatabaseUrl } from "./helpers/db.js";

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

const START = new Date("2030-03-04T15:00:00.000Z");
const END = new Date("2030-03-04T15:45:00.000Z");

async function insertAppointment(doctorId: number, patientId: number, userId: number, status: "booked" | "cancelled", start = START): Promise<void> {
  await pool.execute(
    `INSERT INTO appointment (doctor_id, patient_id, start_utc, end_utc, status, created_by_user_id, created_by_role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'doctor', UTC_TIMESTAMP(3))`,
    [doctorId, patientId, start, new Date(start.getTime() + 45 * 60_000), status, userId],
  );
}

describe("migración 0009 (calendario)", () => {
  it("es idempotente: repetir las migraciones no aplica nada", async () => {
    const { applied } = await runMigrations(testDatabaseUrl(), migrationsDir);
    expect(applied).toEqual([]);
  });

  it("crea las cinco tablas del calendario", async () => {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name LIKE 'calendar\\_%' OR table_name = 'appointment' ORDER BY table_name",
    );
    expect(rows.map((r) => String(r.name))).toEqual([
      "appointment",
      "calendar_action_log",
      "calendar_block",
      "calendar_hours",
      "calendar_settings",
    ]);
  });

  describe("índice único de la cita vigente", () => {
    it("rechaza dos citas booked con el mismo inicio para el mismo médico", async () => {
      const doctor = await createDoctor(pool);
      const patient = await createPatient(pool);
      await insertAppointment(doctor.doctorId, patient.patientId, doctor.user.id, "booked");
      await expect(insertAppointment(doctor.doctorId, patient.patientId, doctor.user.id, "booked")).rejects.toMatchObject({ errno: 1062 });
    });

    it("permite una booked y una cancelled con el mismo inicio, y varias cancelled", async () => {
      const doctor = await createDoctor(pool);
      const patient = await createPatient(pool);
      await insertAppointment(doctor.doctorId, patient.patientId, doctor.user.id, "cancelled");
      await insertAppointment(doctor.doctorId, patient.patientId, doctor.user.id, "cancelled");
      await insertAppointment(doctor.doctorId, patient.patientId, doctor.user.id, "booked");
      const [rows] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM appointment");
      expect(Number(rows[0]?.n)).toBe(3);
    });

    it("permite el mismo inicio para médicos distintos", async () => {
      const a = await createDoctor(pool);
      const b = await createDoctor(pool);
      const patient = await createPatient(pool);
      await insertAppointment(a.doctorId, patient.patientId, a.user.id, "booked");
      await insertAppointment(b.doctorId, patient.patientId, b.user.id, "booked");
    });

    it("cancelar una cita libera su inicio (active_start_utc pasa a NULL)", async () => {
      const doctor = await createDoctor(pool);
      const patient = await createPatient(pool);
      await insertAppointment(doctor.doctorId, patient.patientId, doctor.user.id, "booked");
      await pool.execute("UPDATE appointment SET status = 'cancelled' WHERE doctor_id = ?", [doctor.doctorId]);
      const [rows] = await pool.query<RowDataPacket[]>("SELECT active_start_utc FROM appointment");
      expect(rows[0]?.active_start_utc).toBeNull();
      await insertAppointment(doctor.doctorId, patient.patientId, doctor.user.id, "booked");
    });
  });

  describe("restricciones CHECK", () => {
    it("rechaza una cita con fin igual o anterior al inicio", async () => {
      const doctor = await createDoctor(pool);
      const patient = await createPatient(pool);
      await expect(
        pool.execute(
          `INSERT INTO appointment (doctor_id, patient_id, start_utc, end_utc, created_by_user_id, created_by_role, created_at)
           VALUES (?, ?, ?, ?, ?, 'doctor', UTC_TIMESTAMP(3))`,
          [doctor.doctorId, patient.patientId, END, START, doctor.user.id],
        ),
      ).rejects.toMatchObject({ errno: 3819 });
    });

    it("rechaza un bloqueo con fin igual o anterior al inicio", async () => {
      const doctor = await createDoctor(pool);
      await expect(
        pool.execute(
          "INSERT INTO calendar_block (doctor_id, start_utc, end_utc, created_by_user_id, created_by_role, created_at) VALUES (?, ?, ?, ?, 'doctor', UTC_TIMESTAMP(3))",
          [doctor.doctorId, START, START, doctor.user.id],
        ),
      ).rejects.toMatchObject({ errno: 3819 });
    });

    it.each([
      ["duración 17", { slot: 17, gap: 15 }],
      ["duración 0", { slot: 0, gap: 15 }],
      ["duración 185", { slot: 185, gap: 15 }],
      ["intervalo 7", { slot: 45, gap: 7 }],
      ["intervalo 65", { slot: 45, gap: 65 }],
    ])("rechaza una configuración con %s", async (_name, { slot, gap }) => {
      const doctor = await createDoctor(pool);
      await expect(
        pool.execute(
          "INSERT INTO calendar_settings (doctor_id, slot_minutes, gap_minutes, updated_at) VALUES (?, ?, ?, UTC_TIMESTAMP(3))",
          [doctor.doctorId, slot, gap],
        ),
      ).rejects.toMatchObject({ errno: 3819 });
    });

    it("rechaza una anticipación mínima igual o mayor que la máxima", async () => {
      const doctor = await createDoctor(pool);
      await expect(
        pool.execute(
          "INSERT INTO calendar_settings (doctor_id, min_notice_minutes, max_advance_days, updated_at) VALUES (?, 1440, 1, UTC_TIMESTAMP(3))",
          [doctor.doctorId],
        ),
      ).rejects.toMatchObject({ errno: 3819 });
    });

    it("acepta los valores por defecto", async () => {
      const doctor = await createDoctor(pool);
      await pool.execute("INSERT INTO calendar_settings (doctor_id, updated_at) VALUES (?, UTC_TIMESTAMP(3))", [doctor.doctorId]);
      const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM calendar_settings");
      expect(rows[0]).toMatchObject({ slot_minutes: 45, gap_minutes: 15, timezone: "America/Mexico_City", min_notice_minutes: 120, max_advance_days: 60 });
    });

    it.each([
      ["fin antes del inicio", 600, 540],
      ["fin igual al inicio", 600, 600],
      ["inicio no múltiplo de 5", 603, 700],
      ["fin pasada la medianoche", 600, 1445],
    ])("rechaza una franja con %s", async (_name, start, end) => {
      const doctor = await createDoctor(pool);
      await expect(
        pool.execute("INSERT INTO calendar_hours (doctor_id, weekday, start_minute, end_minute) VALUES (?, 1, ?, ?)", [doctor.doctorId, start, end]),
      ).rejects.toMatchObject({ errno: 3819 });
    });

    it("rechaza un día de la semana fuera de 1–7", async () => {
      const doctor = await createDoctor(pool);
      await expect(
        pool.execute("INSERT INTO calendar_hours (doctor_id, weekday, start_minute, end_minute) VALUES (?, 8, 540, 600)", [doctor.doctorId]),
      ).rejects.toMatchObject({ errno: 3819 });
    });
  });
});
