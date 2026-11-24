import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTables, createDoctor, createEmail, createMetricRow, createTestPool, createUser, resetDatabase } from "./helpers/db.js";

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

describe("migración 0014: panel de soporte", () => {
  it("el médico nuevo nace activo y con los campos de cambio de estado vacíos", async () => {
    const doctor = await createDoctor(pool);
    const [row] = await rows("SELECT account_state, account_state_changed_at, account_state_changed_by FROM doctor WHERE id = ?", [doctor.doctorId]);
    expect(row).toEqual({ account_state: "active", account_state_changed_at: null, account_state_changed_by: null });
  });

  it("account_state solo admite activo, suspendido y solo lectura", async () => {
    const doctor = await createDoctor(pool);
    await expect(pool.execute("UPDATE doctor SET account_state = 'otro' WHERE id = ?", [doctor.doctorId])).rejects.toThrow();
    await pool.execute("UPDATE doctor SET account_state = 'read_only' WHERE id = ?", [doctor.doctorId]);
  });

  it("support_action_log es de solo anexar: UPDATE y DELETE fallan", async () => {
    const support = await createUser(pool, { role: "support" });
    await pool.execute(
      "INSERT INTO support_action_log (support_user_id, action, target_type, target_id, reason, occurred_at) VALUES (?, 'suspend', 'doctor', 1, 'motivo', UTC_TIMESTAMP(3))",
      [support.id],
    );
    await expect(pool.execute("UPDATE support_action_log SET reason = 'otro'")).rejects.toThrow(/solo de anexar|solo anexar/);
    await expect(pool.execute("DELETE FROM support_action_log")).rejects.toThrow(/solo anexar/);
  });

  it("la acción del historial solo admite los valores definidos", async () => {
    const support = await createUser(pool, { role: "support" });
    await expect(
      pool.execute("INSERT INTO support_action_log (support_user_id, action, target_type, target_id, occurred_at) VALUES (?, 'borrar_todo', 'doctor', 1, UTC_TIMESTAMP(3))", [support.id]),
    ).rejects.toThrow();
  });

  it("la reserva de enlaces y los contadores del piloto existen con sus llaves", async () => {
    const doctor = await createDoctor(pool);
    await pool.execute("INSERT INTO site_slug_reservation (slug, doctor_id, reserved_until) VALUES ('clinica-vieja', ?, UTC_TIMESTAMP(3))", [doctor.doctorId]);
    await expect(
      pool.execute("INSERT INTO site_slug_reservation (slug, doctor_id, reserved_until) VALUES ('clinica-vieja', ?, UTC_TIMESTAMP(3))", [doctor.doctorId]),
    ).rejects.toThrow();
    await createMetricRow(pool, doctor.doctorId, "2026-11-23", { started: 3, completed: 2 });
    await expect(createMetricRow(pool, doctor.doctorId, "2026-11-23")).rejects.toThrow();
    expect((await rows("SELECT started, completed, duration_sum_seconds FROM pilot_metric_daily"))[0]).toEqual({ started: 3, completed: 2, duration_sum_seconds: 0 });
  });

  it("email_outbox guarda last_error_code y es nulo por defecto", async () => {
    const id = await createEmail(pool);
    expect((await rows("SELECT last_error_code FROM email_outbox WHERE id = ?", [id]))[0]?.last_error_code).toBeNull();
  });

  it("la misma consulta de la migración copia las decisiones de doctor_review al historial", async () => {
    const support = await createUser(pool, { role: "support" });
    const doctor = await createDoctor(pool);
    await pool.execute("INSERT INTO doctor_review (doctor_id, decision, reason, decided_by_user_id, decided_at) VALUES (?, 'rejected', 'x', ?, '2026-11-01 10:00:00.000')", [doctor.doctorId, support.id]);
    await pool.execute(
      `INSERT INTO support_action_log (support_user_id, action, target_type, target_id, reason, occurred_at)
       SELECT decided_by_user_id, CASE decision WHEN 'approved' THEN 'approve' WHEN 'rejected' THEN 'reject' ELSE 'release_cedula' END, 'doctor', doctor_id, reason, decided_at FROM doctor_review`,
    );
    expect((await rows("SELECT action, target_id FROM support_action_log"))[0]).toEqual({ action: "reject", target_id: doctor.doctorId });
  });

  it("ninguna tabla nueva tiene columnas de nombre, correo, teléfono ni categoría de pacientes", async () => {
    const columns = await rows(
      `SELECT table_name AS t, column_name AS c FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name IN ('support_action_log','site_slug_reservation','pilot_metric_daily')`,
    );
    const forbidden = /(name|email|phone|telefono|mobile|categor|patient|paciente|\bip\b)/i;
    expect(columns.filter((row) => forbidden.test(String(row.c))).map((row) => `${row.t}.${row.c}`)).toEqual([]);
  });
});
