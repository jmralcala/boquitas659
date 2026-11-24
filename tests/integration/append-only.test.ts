import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTables, createDoctor, createPatient, createTestPool, resetDatabase } from "./helpers/db.js";

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

/** Escenario 27: las dos tablas de auditoría rechazan UPDATE y DELETE desde la propia base de datos. */
const TABLES = [
  {
    table: "consent_acceptance",
    triggers: ["consent_acceptance_no_delete", "consent_acceptance_no_update"],
    seed: async (): Promise<void> => {
      const doctor = await createDoctor(pool);
      const legal = await pool.execute("INSERT INTO legal_document (type, version, title, body, is_provisional, published_at) VALUES ('patient_privacy', 1, 't', 'b', 0, UTC_TIMESTAMP(3))");
      await pool.execute("INSERT INTO consent_acceptance (user_id, legal_document_id, accepted_at) VALUES (?, ?, UTC_TIMESTAMP(3))", [doctor.user.id, (legal[0] as { insertId: number }).insertId]);
    },
    updateSql: "UPDATE consent_acceptance SET accepted_at = UTC_TIMESTAMP(3)",
  },
  {
    table: "patient_access_log",
    triggers: ["patient_access_log_no_delete", "patient_access_log_no_update"],
    seed: async (): Promise<void> => {
      const doctor = await createDoctor(pool);
      const patient = await createPatient(pool);
      await pool.execute(
        "INSERT INTO patient_access_log (actor_user_id, actor_role, doctor_id, patient_id, outcome, occurred_at) VALUES (?, 'doctor', ?, ?, 'allowed', UTC_TIMESTAMP(3))",
        [doctor.user.id, doctor.doctorId, patient.patientId],
      );
    },
    updateSql: "UPDATE patient_access_log SET outcome = 'denied'",
  },
  {
    table: "calendar_action_log",
    triggers: ["calendar_action_log_no_delete", "calendar_action_log_no_update"],
    seed: async (): Promise<void> => {
      const doctor = await createDoctor(pool);
      await pool.execute(
        "INSERT INTO calendar_action_log (doctor_id, actor_user_id, actor_role, action, outcome, occurred_at) VALUES (?, ?, 'doctor', 'settings_updated', 'ok', UTC_TIMESTAMP(3))",
        [doctor.doctorId, doctor.user.id],
      );
    },
    updateSql: "UPDATE calendar_action_log SET outcome = 'rejected'",
  },
  {
    table: "data_authorization",
    triggers: ["data_authorization_no_delete", "data_authorization_no_update"],
    seed: async (): Promise<void> => {
      const doctor = await createDoctor(pool);
      const patient = await createPatient(pool);
      const legal = await pool.execute("INSERT INTO legal_document (type, version, title, body, is_provisional, published_at) VALUES ('patient_privacy', 1, 't', 'b', 0, UTC_TIMESTAMP(3))");
      await pool.execute(
        "INSERT INTO data_authorization (account_id, doctor_id, given_by_user_id, legal_document_id, accepted_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3))",
        [patient.accountId, doctor.doctorId, patient.user.id, (legal[0] as { insertId: number }).insertId],
      );
    },
    updateSql: "UPDATE data_authorization SET accepted_at = UTC_TIMESTAMP(3)",
  },
] as const;

describe.each(TABLES)("$table es de solo anexar", ({ table, triggers, seed, updateSql }) => {
  it("tiene los disparadores que bloquean UPDATE y DELETE", async () => {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT trigger_name AS name FROM information_schema.triggers WHERE trigger_schema = DATABASE() AND event_object_table = ? ORDER BY trigger_name",
      [table],
    );
    expect(rows.map((r) => String(r.name))).toEqual([...triggers]);
  });

  it("permite insertar, pero rechaza UPDATE y DELETE sin dejar rastro de cambios", async () => {
    await seed();
    const [before] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${table}\``);
    expect(Number(before[0]?.n)).toBe(1);

    await expect(pool.execute(updateSql)).rejects.toThrow(/solo anexar/);
    await expect(pool.execute(`DELETE FROM \`${table}\``)).rejects.toThrow(/solo anexar/);
    await expect(pool.execute(`DELETE FROM \`${table}\` WHERE id = 1`)).rejects.toThrow(/solo anexar/);

    const [after] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${table}\``);
    expect(Number(after[0]?.n)).toBe(1);
  });
});

describe("el código de la aplicación nunca actualiza ni borra esas tablas", () => {
  it("ninguna sentencia SQL del código fuente hace UPDATE o DELETE sobre ellas", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith(".ts")) files.push(full);
      }
    };
    walk("src");

    // Única excepción: la limpieza periódica borra el registro de acciones de la agenda de más de 90 días (retención).
    // Los disparadores de la migración 0010 impiden borrar cualquier fila más reciente.
    const isRetention = (file: string): boolean => file.replace(/\\/g, "/").endsWith("src/jobs/cleanup-service.ts");
    const offenders = files.filter((file) => {
      const tables = isRetention(file)
        ? "consent_acceptance|patient_access_log|data_authorization"
        : "consent_acceptance|patient_access_log|calendar_action_log|data_authorization";
      return new RegExp(`(UPDATE|DELETE\\s+FROM)\\s+\`?(${tables})\`?`, "i").test(readFileSync(file, "utf8"));
    });
    expect(offenders).toEqual([]);
  });
});
