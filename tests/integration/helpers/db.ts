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

const LEGAL_TYPES_BY_ROLE: Record<Role, string[]> = {
  patient: ["patient_privacy"],
  doctor: ["doctor_privacy", "terms_doctor"],
  reception: ["reception_privacy", "reception_confidentiality"],
  support: [],
};

/** Registra la aceptación de la última versión de los documentos legales publicados que aplican al rol. */
export async function acceptLatestLegalDocuments(pool: Db, userId: number, role: Role): Promise<void> {
  const types = LEGAL_TYPES_BY_ROLE[role];
  if (types.length === 0) return;
  await pool.execute(
    `INSERT INTO consent_acceptance (user_id, legal_document_id, accepted_at)
     SELECT ?, d.id, UTC_TIMESTAMP(3) FROM legal_document d
      WHERE d.type IN (${types.map(() => "?").join(", ")})
        AND d.version = (SELECT MAX(x.version) FROM legal_document x WHERE x.type = d.type)`,
    [userId, ...types],
  );
}

/**
 * Usuario de fábrica. Por defecto queda con la última versión publicada de los avisos de su rol aceptada
 * (`acceptLegal: false` para probar el filtro de reaceptación).
 */
export async function createUser(
  pool: Db,
  options: { role?: Role; email?: string; status?: "active" | "disabled"; acceptLegal?: boolean } = {},
): Promise<CreatedUser> {
  userCounter += 1;
  const role = options.role ?? "patient";
  const email = (options.email ?? `usuario${userCounter}.${role}@example.com`).toLowerCase();
  const [result] = await pool.execute<import("mysql2/promise").ResultSetHeader>(
    "INSERT INTO `user` (email, email_normalized, role, password_hash, password_changed_at, status) VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3), ?)",
    [email, email, role, await defaultPasswordHash(), options.status ?? "active"],
  );
  if (options.acceptLegal !== false) await acceptLatestLegalDocuments(pool, result.insertId, role);
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

/** Vínculo vigente de una persona de recepción con un médico. */
export async function createMembership(pool: Db, doctorId: number, receptionUserId: number): Promise<number> {
  const [result] = await pool.execute<import("mysql2/promise").ResultSetHeader>(
    "INSERT INTO reception_membership (doctor_id, reception_user_id, active_flag, created_at) VALUES (?, ?, 1, UTC_TIMESTAMP(3))",
    [doctorId, receptionUserId],
  );
  return result.insertId;
}

export async function createInvitation(
  pool: Db,
  options: {
    doctorId: number;
    invitedByUserId: number;
    email: string;
    status?: "pending" | "accepted" | "expired" | "revoked";
    expiresAt?: Date;
  },
): Promise<number> {
  const [result] = await pool.execute<import("mysql2/promise").ResultSetHeader>(
    `INSERT INTO reception_invitation (doctor_id, email_normalized, status, invited_by_user_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3), ?)`,
    [
      options.doctorId,
      options.email.toLowerCase(),
      options.status ?? "pending",
      options.invitedByUserId,
      options.expiresAt ?? new Date(Date.now() + 7 * 86_400_000),
    ],
  );
  return result.insertId;
}

// --- Calendario (feature 2) ----------------------------------------------------------------------------------------

export interface CalendarSettingsOverrides {
  slotMinutes?: number;
  gapMinutes?: number;
  timezone?: string;
  minNoticeMinutes?: number;
  maxAdvanceDays?: number;
  cancelNoticeHours?: number;
}

/** Configuración del calendario de un médico (valores por defecto salvo lo indicado). */
export async function createCalendarSettings(pool: Db, doctorId: number, overrides: CalendarSettingsOverrides = {}): Promise<void> {
  await pool.execute(
    `INSERT INTO calendar_settings (doctor_id, slot_minutes, gap_minutes, timezone, min_notice_minutes, max_advance_days, cancel_notice_hours, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
    [
      doctorId,
      overrides.slotMinutes ?? 45,
      overrides.gapMinutes ?? 15,
      overrides.timezone ?? "America/Mexico_City",
      overrides.minNoticeMinutes ?? 120,
      overrides.maxAdvanceDays ?? 60,
      overrides.cancelNoticeHours ?? 24,
    ],
  );
}

/** Franjas del horario semanal (1 = lunes … 7 = domingo; minutos desde las 00:00 locales). */
export async function createCalendarHours(
  pool: Db,
  doctorId: number,
  ranges: readonly { weekday: number; startMinute: number; endMinute: number }[],
): Promise<void> {
  for (const range of ranges) {
    await pool.execute("INSERT INTO calendar_hours (doctor_id, weekday, start_minute, end_minute) VALUES (?, ?, ?, ?)", [
      doctorId,
      range.weekday,
      range.startMinute,
      range.endMinute,
    ]);
  }
}

/** Lunes a viernes de 9:00 a 14:00 y de 16:00 a 19:00 (el horario de los ejemplos de la spec). */
export const WEEKDAY_HOURS = [1, 2, 3, 4, 5].flatMap((weekday) => [
  { weekday, startMinute: 9 * 60, endMinute: 14 * 60 },
  { weekday, startMinute: 16 * 60, endMinute: 19 * 60 },
]);

/** Cita de fábrica; crea el vínculo médico-paciente si falta. `endUtc` por defecto es inicio + 45 min. */
export async function createAppointment(
  pool: Db,
  options: {
    doctorId: number;
    patientId: number;
    startUtc: Date;
    endUtc?: Date;
    status?: "booked" | "cancelled";
    createdByUserId?: number;
    createdByRole?: "doctor" | "reception" | "patient";
    createdAt?: Date;
  },
): Promise<number> {
  await pool.execute("INSERT INTO doctor_patient (doctor_id, patient_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE doctor_id = doctor_id", [
    options.doctorId,
    options.patientId,
  ]);
  let createdBy = options.createdByUserId;
  if (createdBy === undefined) {
    const [rows] = await pool.query<import("mysql2/promise").RowDataPacket[]>("SELECT user_id FROM doctor WHERE id = ?", [options.doctorId]);
    createdBy = Number(rows[0]?.user_id);
  }
  const [result] = await pool.execute<import("mysql2/promise").ResultSetHeader>(
    `INSERT INTO appointment (doctor_id, patient_id, start_utc, end_utc, status, created_by_user_id, created_by_role, created_at,
                              cancelled_by_user_id, cancelled_by_role, cancelled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      options.doctorId,
      options.patientId,
      options.startUtc,
      options.endUtc ?? new Date(options.startUtc.getTime() + 45 * 60_000),
      options.status ?? "booked",
      createdBy,
      options.createdByRole ?? "doctor",
      options.createdAt ?? new Date(),
      options.status === "cancelled" ? createdBy : null,
      options.status === "cancelled" ? (options.createdByRole ?? "doctor") : null,
      options.status === "cancelled" ? new Date() : null,
    ],
  );
  return result.insertId;
}

/** Bloqueo de fábrica. */
export async function createBlock(
  pool: Db,
  options: { doctorId: number; startUtc: Date; endUtc: Date; reason?: string; createdByUserId?: number; createdByRole?: "doctor" | "reception" },
): Promise<number> {
  let createdBy = options.createdByUserId;
  if (createdBy === undefined) {
    const [rows] = await pool.query<import("mysql2/promise").RowDataPacket[]>("SELECT user_id FROM doctor WHERE id = ?", [options.doctorId]);
    createdBy = Number(rows[0]?.user_id);
  }
  const [result] = await pool.execute<import("mysql2/promise").ResultSetHeader>(
    `INSERT INTO calendar_block (doctor_id, start_utc, end_utc, reason, created_by_user_id, created_by_role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
    [options.doctorId, options.startUtc, options.endUtc, options.reason ?? null, createdBy, options.createdByRole ?? "doctor"],
  );
  return result.insertId;
}

// --- Micrositio y reserva del paciente (feature 3) ----------------------------------------------------------------------

/** Fila de `doctor_site` (por defecto en borrador, con un nombre derivado del médico). */
export async function createDoctorSite(
  pool: Db,
  doctorId: number,
  options: { slug?: string; address?: string | null; status?: "draft" | "published" | "unpublished"; firstPublishedAt?: Date | null; logoFile?: string | null } = {},
): Promise<string> {
  const slug = options.slug ?? `dr-prueba-${doctorId}`;
  const status = options.status ?? "draft";
  const firstPublishedAt = options.firstPublishedAt === undefined ? (status === "draft" ? null : new Date()) : options.firstPublishedAt;
  await pool.execute(
    `INSERT INTO doctor_site (doctor_id, slug, address, logo_file, status, first_published_at, published_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
    [doctorId, slug, options.address === undefined ? null : options.address, options.logoFile ?? null, status, firstPublishedAt, status === "published" ? firstPublishedAt : null],
  );
  return slug;
}

/**
 * Micrositio listo para recibir reservas: teléfono del consultorio, dirección, configuración con el horario de los
 * ejemplos (lunes a viernes de 9 a 14 y de 16 a 19) y estado publicado.
 */
export async function createPublishedSite(
  pool: Db,
  doctor: CreatedDoctor,
  options: { slug?: string; settings?: CalendarSettingsOverrides; hours?: readonly { weekday: number; startMinute: number; endMinute: number }[] } = {},
): Promise<{ slug: string }> {
  await pool.execute("UPDATE doctor SET office_phone = '5598765432' WHERE id = ?", [doctor.doctorId]);
  await createCalendarSettings(pool, doctor.doctorId, options.settings);
  await createCalendarHours(pool, doctor.doctorId, options.hours ?? WEEKDAY_HOURS);
  const slug = await createDoctorSite(pool, doctor.doctorId, { slug: options.slug, address: "Calle Falsa 123, Centro", status: "published" });
  return { slug };
}

/** Paciente adicional (menor) bajo una cuenta. */
export async function createDependent(pool: Db, accountId: number, fullName = "Menor de Prueba"): Promise<number> {
  const [result] = await pool.execute<import("mysql2/promise").ResultSetHeader>(
    "INSERT INTO patient (account_id, full_name, birth_date, is_minor_dependent) VALUES (?, ?, '2018-03-01', 1)",
    [accountId, fullName],
  );
  return result.insertId;
}

/** Autorización de datos de una cuenta con un consultorio (con el aviso de privacidad vigente). */
export async function createDataAuthorization(
  pool: Db,
  options: { accountId: number; doctorId: number; userId: number; at?: Date },
): Promise<number> {
  const [docs] = await pool.query<RowDataPacket[]>("SELECT id FROM legal_document WHERE type = 'patient_privacy' ORDER BY version DESC LIMIT 1");
  let documentId = Number(docs[0]?.id);
  if (!documentId) {
    const [created] = await pool.execute<import("mysql2/promise").ResultSetHeader>(
      "INSERT INTO legal_document (type, version, title, body, is_provisional, published_at) VALUES ('patient_privacy', 1, 't', 'b', 0, UTC_TIMESTAMP(3))",
    );
    documentId = created.insertId;
  }
  const [result] = await pool.execute<import("mysql2/promise").ResultSetHeader>(
    "INSERT INTO data_authorization (account_id, doctor_id, given_by_user_id, legal_document_id, accepted_at) VALUES (?, ?, ?, ?, ?)",
    [options.accountId, options.doctorId, options.userId, documentId, options.at ?? new Date()],
  );
  return result.insertId;
}

/** Aviso de privacidad de pacientes vigente (lo crea si no existe) y su id. */
export async function ensurePrivacyDocument(pool: Db): Promise<number> {
  const [docs] = await pool.query<RowDataPacket[]>("SELECT id FROM legal_document WHERE type = 'patient_privacy' ORDER BY version DESC LIMIT 1");
  if (docs[0]) return Number(docs[0].id);
  const [created] = await pool.execute<import("mysql2/promise").ResultSetHeader>(
    "INSERT INTO legal_document (type, version, title, body, is_provisional, published_at) VALUES ('patient_privacy', 1, 'Aviso', 'Texto', 0, UTC_TIMESTAMP(3))",
  );
  return created.insertId;
}
