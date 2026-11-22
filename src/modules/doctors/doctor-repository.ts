import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";

type Executor = Pick<Pool, "execute"> | Pick<PoolConnection, "execute">;

export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface Doctor {
  id: number;
  userId: number;
  email: string;
  fullName: string;
  cedulaNumber: string | null;
  cedulaNormalized: string | null;
  cedulaFilePath: string | null;
  emergencyMobile: string | null;
  officePhone: string | null;
  approvalStatus: ApprovalStatus;
  rejectionReason: string | null;
  approvedAt: Date | null;
  trialStartedAt: Date | null;
  trialEndsAt: Date | null;
  createdAt: Date;
}

const SELECT = `SELECT d.id, d.user_id, u.email, d.full_name, d.cedula_number, d.cedula_normalized, d.cedula_file_path,
       d.emergency_mobile, d.office_phone, d.approval_status, d.rejection_reason, d.approved_at,
       d.trial_started_at, d.trial_ends_at, d.created_at
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
    emergencyMobile: row.emergency_mobile === null ? null : String(row.emergency_mobile),
    officePhone: row.office_phone === null ? null : String(row.office_phone),
    approvalStatus: row.approval_status as ApprovalStatus,
    rejectionReason: row.rejection_reason === null ? null : String(row.rejection_reason),
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
    emergencyMobile: string;
    officePhone: string | null;
    createdAt: Date;
  },
): Promise<number> {
  const [result] = await executor.execute<ResultSetHeader>(
    `INSERT INTO doctor (user_id, full_name, cedula_number, cedula_normalized, cedula_file_path, cedula_file_sha256,
                         emergency_mobile, office_phone, approval_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [
      input.userId,
      input.fullName,
      input.cedulaNumber,
      input.cedulaNormalized,
      input.cedulaFilePath,
      input.cedulaFileSha256,
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
