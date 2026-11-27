import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";

type Executor = Pick<Pool, "execute"> | Pick<PoolConnection, "execute">;

export type ApprovalStatus = "pending" | "approved" | "rejected";

/** Estado operativo de la cuenta (feature 5), independiente de la aprobación de la cédula. */
export type AccountState = "active" | "suspended" | "read_only";

export interface Doctor {
  id: number;
  userId: number;
  email: string;
  fullName: string;
  cedulaNumber: string | null;
  cedulaNormalized: string | null;
  cedulaFilePath: string | null;
  /** Identificación oficial subida por el médico (nula en cuentas anteriores a su exigencia). */
  idFilePath: string | null;
  emergencyMobile: string | null;
  officePhone: string | null;
  approvalStatus: ApprovalStatus;
  rejectionReason: string | null;
  accountState: AccountState;
  accountStateChangedAt: Date | null;
  accountStateChangedBy: number | null;
  approvedAt: Date | null;
  trialStartedAt: Date | null;
  trialEndsAt: Date | null;
  createdAt: Date;
}

const SELECT = `SELECT d.id, d.user_id, u.email, d.full_name, d.cedula_number, d.cedula_normalized, d.cedula_file_path, d.id_file_path,
       d.emergency_mobile, d.office_phone, d.approval_status, d.rejection_reason, d.approved_at,
       d.trial_started_at, d.trial_ends_at, d.created_at,
       d.account_state, d.account_state_changed_at, d.account_state_changed_by
  FROM doctor d JOIN \`user\` u ON u.id = d.user_id`;

function toDoctor(row: RowDataPacket): Doctor {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    email: String(row.email),
    fullName: String(row.full_name),
    cedulaNumber: row.cedula_number === null ? null : String(row.cedula_number),
    cedulaNormalized: row.cedula_normalized === null ? null : String(row.cedula_normalized),
    cedulaFilePath: row.cedula_file_path === null ? null : String(row.cedula_file_path),
    idFilePath: row.id_file_path === null ? null : String(row.id_file_path),
    emergencyMobile: row.emergency_mobile === null ? null : String(row.emergency_mobile),
    officePhone: row.office_phone === null ? null : String(row.office_phone),
    approvalStatus: row.approval_status as ApprovalStatus,
    rejectionReason: row.rejection_reason === null ? null : String(row.rejection_reason),
    accountState: row.account_state as AccountState,
    accountStateChangedAt: row.account_state_changed_at as Date | null,
    accountStateChangedBy: row.account_state_changed_by === null ? null : Number(row.account_state_changed_by),
    approvedAt: row.approved_at as Date | null,
    trialStartedAt: row.trial_started_at as Date | null,
    trialEndsAt: row.trial_ends_at as Date | null,
    createdAt: row.created_at as Date,
  };
}

export async function findDoctorByUserId(executor: Executor, userId: number, lock = false): Promise<Doctor | null> {
  const [rows] = await executor.execute<RowDataPacket[]>(`${SELECT} WHERE d.user_id = ?${lock ? " FOR UPDATE" : ""}`, [
    userId,
  ]);
  return rows[0] ? toDoctor(rows[0]) : null;
}

export async function findDoctorById(executor: Executor, id: number, lock = false): Promise<Doctor | null> {
  const [rows] = await executor.execute<RowDataPacket[]>(`${SELECT} WHERE d.id = ?${lock ? " FOR UPDATE" : ""}`, [id]);
  return rows[0] ? toDoctor(rows[0]) : null;
}

export type DoctorListFilter = ApprovalStatus | AccountState | "all";

/** Escapa los comodines de LIKE para que una búsqueda con `%` o `_` sea literal. */
export function escapeLike(value: string): string {
  return value.replace(/[|%_]/g, (char) => `|${char}`);
}

/**
 * Lista del panel de soporte: por estado de aprobación o por estado operativo (de los médicos aprobados), con búsqueda
 * opcional por nombre o correo del médico. Máximo 200, las solicitudes más antiguas primero.
 */
export async function searchDoctors(executor: Executor, filter: { estado: DoctorListFilter; q?: string }): Promise<Doctor[]> {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.estado === "suspended" || filter.estado === "read_only") {
    where.push("d.approval_status = 'approved' AND d.account_state = ?");
    params.push(filter.estado);
  } else if (filter.estado === "active") {
    where.push("d.approval_status = 'approved' AND d.account_state = 'active'");
  } else if (filter.estado !== "all") {
    where.push("d.approval_status = ?");
    params.push(filter.estado);
  }
  const q = filter.q?.trim();
  if (q) {
    where.push("(d.full_name LIKE ? ESCAPE '|' OR u.email LIKE ? ESCAPE '|')");
    params.push(`%${escapeLike(q)}%`, `%${escapeLike(q)}%`);
  }
  const order = filter.estado === "pending" ? "ASC" : "DESC";
  const [rows] = await executor.execute<RowDataPacket[]>(
    `${SELECT}${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY d.created_at ${order}, d.id ${order} LIMIT 200`,
    params,
  );
  return rows.map(toDoctor);
}

export async function listDoctors(executor: Executor, status: ApprovalStatus | "all"): Promise<Doctor[]> {
  const [rows] =
    status === "all"
      ? await executor.execute<RowDataPacket[]>(`${SELECT} ORDER BY d.created_at DESC, d.id DESC LIMIT 200`)
      : await executor.execute<RowDataPacket[]>(
          `${SELECT} WHERE d.approval_status = ? ORDER BY d.created_at ASC, d.id ASC LIMIT 200`,
          [status],
        );
  return rows.map(toDoctor);
}

export async function insertDoctor(
  executor: Executor,
  input: {
    userId: number;
    fullName: string;
    cedulaNumber: string;
    cedulaNormalized: string;
    cedulaFilePath: string;
    cedulaFileSha256: string;
    idFilePath: string;
    idFileSha256: string;
    emergencyMobile: string;
    officePhone: string | null;
    createdAt: Date;
  },
): Promise<number> {
  const [result] = await executor.execute<ResultSetHeader>(
    `INSERT INTO doctor (user_id, full_name, cedula_number, cedula_normalized, cedula_file_path, cedula_file_sha256,
                         id_file_path, id_file_sha256, emergency_mobile, office_phone, approval_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [
      input.userId,
      input.fullName,
      input.cedulaNumber,
      input.cedulaNormalized,
      input.cedulaFilePath,
      input.cedulaFileSha256,
      input.idFilePath,
      input.idFileSha256,
      input.emergencyMobile,
      input.officePhone,
      input.createdAt,
    ],
  );
  return result.insertId;
}

export async function insertReview(
  executor: Executor,
  input: {
    doctorId: number;
    decision: "approved" | "rejected" | "cedula_released";
    reason: string | null;
    decidedByUserId: number;
    decidedAt: Date;
  },
): Promise<void> {
  await executor.execute(
    "INSERT INTO doctor_review (doctor_id, decision, reason, decided_by_user_id, decided_at) VALUES (?, ?, ?, ?, ?)",
    [input.doctorId, input.decision, input.reason, input.decidedByUserId, input.decidedAt],
  );
}
