import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import { clearTables, createAppointment, createDoctor, createPatient, createTestPool, linkPatientToDoctor, migrationsDir, resetDatabase, testDatabaseUrl } from "./helpers/db.js";

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

describe("migración 0011 (micrositio)", () => {
  it("es idempotente: repetir las migraciones no aplica nada", async () => {
    expect((await runMigrations(testDatabaseUrl(), migrationsDir)).applied).toEqual([]);
  });

  describe("doctor_site", () => {
    const insert = (doctorId: number, slug: string) =>
      pool.execute("INSERT INTO doctor_site (doctor_id, slug, created_at, updated_at) VALUES (?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))", [doctorId, slug]);

    it("el nombre del enlace es único: el segundo intento falla con 1062", async () => {
      const a = await createDoctor(pool);
      const b = await createDoctor(pool);
      await insert(a.doctorId, "clinica-sonrisa");
      await expect(insert(b.doctorId, "clinica-sonrisa")).rejects.toMatchObject({ errno: 1062 });
    });

    it("dos inserciones simultáneas del mismo nombre: exactamente una prospera", async () => {
      const a = await createDoctor(pool);
      const b = await createDoctor(pool);
      const results = await Promise.allSettled([insert(a.doctorId, "mismo-nombre"), insert(b.doctorId, "mismo-nombre")]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    });

    it.each([["ab", 3819], ["x".repeat(41), 1406]])("rechaza una longitud fuera de 3–40 (%s)", async (slug, errno) => {
      const doctor = await createDoctor(pool);
      await expect(insert(doctor.doctorId, slug)).rejects.toMatchObject({ errno });
    });

    it("acepta 3 y 40 caracteres y empieza en borrador", async () => {
      const a = await createDoctor(pool);
      const b = await createDoctor(pool);
      await insert(a.doctorId, "abc");
      await insert(b.doctorId, "x".repeat(40));
      expect((await rows("SELECT status FROM doctor_site ORDER BY doctor_id")).map((r) => r.status)).toEqual(["draft", "draft"]);
    });

    it("un médico tiene un solo micrositio", async () => {
      const doctor = await createDoctor(pool);
      await insert(doctor.doctorId, "uno-solo");
      await expect(insert(doctor.doctorId, "otro-nombre")).rejects.toMatchObject({ errno: 1062 });
    });
  });

  describe("cambios en tablas existentes", () => {
    it("calendar_settings.cancel_notice_hours vale 24 por defecto, acepta 0 y 168 y rechaza 169", async () => {
      const a = await createDoctor(pool);
      const b = await createDoctor(pool);
      const c = await createDoctor(pool);
      await pool.execute("INSERT INTO calendar_settings (doctor_id, updated_at) VALUES (?, UTC_TIMESTAMP(3))", [a.doctorId]);
      expect((await rows("SELECT cancel_notice_hours FROM calendar_settings"))[0]?.cancel_notice_hours).toBe(24);
      await pool.execute("INSERT INTO calendar_settings (doctor_id, cancel_notice_hours, updated_at) VALUES (?, 0, UTC_TIMESTAMP(3))", [b.doctorId]);
      await pool.execute("UPDATE calendar_settings SET cancel_notice_hours = 168 WHERE doctor_id = ?", [b.doctorId]);
      await expect(
        pool.execute("INSERT INTO calendar_settings (doctor_id, cancel_notice_hours, updated_at) VALUES (?, 169, UTC_TIMESTAMP(3))", [c.doctorId]),
      ).rejects.toMatchObject({ errno: 3819 });
    });

    it("doctor_patient guarda origen y revocación; los vínculos existentes son de origen office", async () => {
      const doctor = await createDoctor(pool);
      const patient = await createPatient(pool);
      await linkPatientToDoctor(pool, doctor.doctorId, patient.patientId);
      expect((await rows("SELECT origin, revoked_at, created_by_user_id FROM doctor_patient"))[0]).toEqual({ origin: "office", revoked_at: null, created_by_user_id: null });
      await pool.execute("UPDATE doctor_patient SET origin = 'patient', created_by_user_id = ?, revoked_at = UTC_TIMESTAMP(3)", [patient.user.id]);
      expect((await rows("SELECT origin FROM doctor_patient"))[0]?.origin).toBe("patient");
    });

    it("appointment acepta created_by_role y cancelled_by_role = 'patient' y guarda la marca del recordatorio", async () => {
      const doctor = await createDoctor(pool);
      const patient = await createPatient(pool);
      const id = await createAppointment(pool, { doctorId: doctor.doctorId, patientId: patient.patientId, startUtc: new Date("2030-03-04T15:00:00.000Z"), createdByUserId: patient.user.id, createdByRole: "doctor" });
      await pool.execute("UPDATE appointment SET created_by_role = 'patient', status = 'cancelled', cancelled_by_user_id = ?, cancelled_by_role = 'patient', cancelled_at = UTC_TIMESTAMP(3), reminder_enqueued_at = UTC_TIMESTAMP(3) WHERE id = ?", [patient.user.id, id]);
      expect((await rows("SELECT created_by_role, cancelled_by_role, reminder_enqueued_at FROM appointment WHERE id = ?", [id]))[0]).toMatchObject({ created_by_role: "patient", cancelled_by_role: "patient" });
    });

    it("calendar_action_log acepta el rol patient y las acciones nuevas", async () => {
      const doctor = await createDoctor(pool);
      const patient = await createPatient(pool);
      for (const action of ["site_updated", "data_authorized", "link_revoked"]) {
        await pool.execute(
          "INSERT INTO calendar_action_log (doctor_id, actor_user_id, actor_role, action, outcome, occurred_at) VALUES (?, ?, 'patient', ?, 'ok', UTC_TIMESTAMP(3))",
          [doctor.doctorId, patient.user.id, action],
        );
      }
      expect(await rows("SELECT id FROM calendar_action_log")).toHaveLength(3);
    });

    it("one_time_token acepta los propósitos de cita con appointment_id", async () => {
      const doctor = await createDoctor(pool);
      const patient = await createPatient(pool);
      const id = await createAppointment(pool, { doctorId: doctor.doctorId, patientId: patient.patientId, startUtc: new Date("2030-03-04T15:00:00.000Z") });
      for (const [index, purpose] of ["appointment_confirmation", "appointment_reminder"].entries()) {
        await pool.execute(
          "INSERT INTO one_time_token (token_hash, purpose, appointment_id, expires_at, created_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3))",
          [String(index).repeat(64), purpose, id, new Date("2031-01-01T00:00:00.000Z")],
        );
      }
      expect(await rows("SELECT id FROM one_time_token WHERE appointment_id = ?", [id])).toHaveLength(2);
      // Los propósitos anteriores siguen valiendo.
      await pool.execute("INSERT INTO one_time_token (token_hash, purpose, user_id, expires_at, created_at) VALUES (?, 'password_reset', ?, ?, UTC_TIMESTAMP(3))", ["f".repeat(64), patient.user.id, new Date("2031-01-01T00:00:00.000Z")]);
    });
  });

  describe("data_authorization", () => {
    async function seed(): Promise<number> {
      const doctor = await createDoctor(pool);
      const patient = await createPatient(pool);
      const [legal] = await pool.execute<import("mysql2/promise").ResultSetHeader>(
        "INSERT INTO legal_document (type, version, title, body, is_provisional, published_at) VALUES ('patient_privacy', 1, 't', 'b', 0, UTC_TIMESTAMP(3))",
      );
      const [result] = await pool.execute<import("mysql2/promise").ResultSetHeader>(
        "INSERT INTO data_authorization (account_id, doctor_id, given_by_user_id, legal_document_id, accepted_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3))",
        [patient.accountId, doctor.doctorId, patient.user.id, legal.insertId],
      );
      return result.insertId;
    }

    it("permite insertar y rechaza UPDATE y DELETE", async () => {
      await seed();
      await expect(pool.execute("UPDATE data_authorization SET accepted_at = UTC_TIMESTAMP(3)")).rejects.toThrow(/solo anexar/);
      await expect(pool.execute("DELETE FROM data_authorization")).rejects.toThrow(/solo anexar/);
      expect(await rows("SELECT id FROM data_authorization")).toHaveLength(1);
    });
  });
});
