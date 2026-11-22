import { fileURLToPath } from "node:url";
import type { RowDataPacket } from "mysql2/promise";
import { createPool, type Db } from "../../../src/db/pool.js";
import { runMigrations } from "../../../src/db/migrate.js";
import { createPasswordHasher } from "../../../src/modules/auth/password-hasher.js";

export const migrationsDir = fileURLToPath(new URL("../../../migrations/", import.meta.url));

export const DEFAULT_TEST_PASSWORD = "contraseña-de-prueba-123";

/** URL de la base de pruebas. Se niega a usar una base cuyo nombre no termine en `_test`. */
export function testDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) throw new Error("TEST_DATABASE_URL no está definida.");
  const name = new URL(raw).pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) {
    throw new Error("TEST_DATABASE_URL debe apuntar a una base cuyo nombre termine en _test.");
  }
  return raw;
}

export function createTestPool(): Db {
  return createPool(testDatabaseUrl(), 5);
}

async function listTables(pool: Db): Promise<string[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'",
  );
  return rows.map((row) => String(row.name));
}

/** Borra todas las tablas (y con ellas sus disparadores) de la base de pruebas. */
export async function dropAllTables(pool: Db): Promise<void> {
  const connection = await pool.getConnection();
  try {
    await connection.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const name of await listTables(pool)) {
      await connection.query(`DROP TABLE IF EXISTS \`${name}\``);
    }
    await connection.query("SET FOREIGN_KEY_CHECKS = 1");
  } finally {
    connection.release();
  }
}

/** Recrea el esquema desde cero. Llamar una vez por archivo de pruebas (`beforeAll`). */
export async function resetDatabase(pool: Db): Promise<void> {
  await dropAllTables(pool);
  await runMigrations(testDatabaseUrl(), migrationsDir);
}

/** Vacía los datos entre pruebas sin tocar el esquema (TRUNCATE no dispara los disparadores de solo anexar). */
export async function clearTables(pool: Db): Promise<void> {
  const connection = await pool.getConnection();
  try {
    await connection.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const name of await listTables(pool)) {
      if (name === "schema_migrations") continue;
      await connection.query(`TRUNCATE TABLE \`${name}\``);
    }
    await connection.query("SET FOREIGN_KEY_CHECKS = 1");
  } finally {
    connection.release();
  }
}

// Se calcula una sola vez: hashear en cada fábrica haría lentas las pruebas.
let cachedHash: Promise<string> | undefined;
function defaultPasswordHash(): Promise<string> {
  cachedHash ??= createPasswordHasher("bcrypt", { bcryptCost: 4 }).hash(DEFAULT_TEST_PASSWORD);
  return cachedHash;
}

export type Role = "patient" | "doctor" | "reception" | "support";

let userCounter = 0;

export interface CreatedUser {
  id: number;
  email: string;
  role: Role;
  password: string;
}

export async function createUser(
  pool: Db,
  options: { role?: Role; email?: string; status?: "active" | "disabled" } = {},
): Promise<CreatedUser> {
  userCounter += 1;
  const role = options.role ?? "patient";
  const email = (options.email ?? `usuario${userCounter}.${role}@example.com`).toLowerCase();
  const [result] = await pool.execute<import("mysql2/promise").ResultSetHeader>(
    "INSERT INTO `user` (email, email_normalized, role, password_hash, password_changed_at, status) VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3), ?)",
    [email, email, role, await defaultPasswordHash(), options.status ?? "active"],
  );
  return { id: result.insertId, email, role, password: DEFAULT_TEST_PASSWORD };
}

let patientCounter = 0;

export interface CreatedPatient {
  user: CreatedUser;
  accountId: number;
  patientId: number;
}

/** Cuenta de paciente de fábrica (usuario, cuenta y el propio paciente). */
export async function createPatient(
  pool: Db,
  options: { email?: string; fullName?: string; birthDate?: string } = {},
): Promise<CreatedPatient> {
  patientCounter += 1;
  const user = await createUser(pool, { role: "patient", email: options.email });
  const [account] = await pool.execute<import("mysql2/promise").ResultSetHeader>(
    "INSERT INTO patient_account (user_id, phone) VALUES (?, ?)",
    [user.id, "5512345678"],
  );
  const [patient] = await pool.execute<import("mysql2/promise").ResultSetHeader>(
    "INSERT INTO patient (account_id, full_name, birth_date, email, phone, is_minor_dependent) VALUES (?, ?, ?, ?, ?, 0)",
    [
      account.insertId,
      options.fullName ?? `Paciente Prueba ${patientCounter}`,
      options.birthDate ?? "1990-05-17",
      user.email,
      "5512345678",
    ],
  );
  return { user, accountId: account.insertId, patientId: patient.insertId };
}

export async function linkPatientToDoctor(pool: Db, doctorId: number, patientId: number): Promise<void> {
  await pool.execute("INSERT INTO doctor_patient (doctor_id, patient_id) VALUES (?, ?)", [doctorId, patientId]);
}

let doctorCounter = 0;

export interface CreatedDoctor {
  user: CreatedUser;
  doctorId: number;
  cedula: string;
  mobile: string;
}

/** Médico de fábrica con cédula y móvil únicos. Por defecto queda aprobado. */
export async function createDoctor(
  pool: Db,
  options: {
    status?: "pending" | "approved" | "rejected";
    email?: string;
    fullName?: string;
    cedulaFileName?: string;
  } = {},
): Promise<CreatedDoctor> {
  doctorCounter += 1;
  const user = await createUser(pool, { role: "doctor", email: options.email });
  const cedula = String(1000000 + doctorCounter);
  const mobile = `55${String(10000000 + doctorCounter)}`;
  const status = options.status ?? "approved";
  const [result] = await pool.execute<import("mysql2/promise").ResultSetHeader>(
    `INSERT INTO doctor (user_id, full_name, cedula_number, cedula_normalized, cedula_file_path, emergency_mobile,
                         approval_status, rejection_reason, approved_at, approved_by_user_id, trial_started_at, trial_ends_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    [
      user.id,
      options.fullName ?? `Dr. Prueba ${doctorCounter}`,
      cedula,
      cedula,
      options.cedulaFileName ?? null,
      mobile,
      status,
      status === "rejected" ? "Motivo de prueba" : null,
      status === "approved" ? new Date() : null,
      status === "approved" ? new Date() : null,
      status === "approved" ? new Date(Date.now() + 5 * 86_400_000) : null,
    ],
  );
  return { user, doctorId: result.insertId, cedula, mobile };
}
