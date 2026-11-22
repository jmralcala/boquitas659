import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";

type Executor = Pick<Pool, "execute"> | Pick<PoolConnection, "execute">;

export const MAX_RECEPTION_PER_DOCTOR = 2;

export interface InvitationRecord {
  id: number;
  doctorId: number;
  email: string;
  status: "pending" | "accepted" | "expired" | "revoked";
  createdAt: Date;
  expiresAt: Date;
}

export interface MemberRecord {
  membershipId: number;
  receptionUserId: number;
  email: string;
  fullName: string | null;
  createdAt: Date;
}

function toInvitation(row: RowDataPacket): InvitationRecord {
  return {
    id: Number(row.id),
    doctorId: Number(row.doctor_id),
    email: String(row.email_normalized),
    status: row.status as InvitationRecord["status"],
    createdAt: row.created_at as Date,
    expiresAt: row.expires_at as Date,
  };
}

/** Bloquea la fila del médico: las invitaciones simultáneas del mismo médico se serializan (la fila siempre existe). */
export async function lockDoctorRow(executor: Executor, doctorId: number): Promise<boolean> {
  const [rows] = await executor.execute<RowDataPacket[]>("SELECT id FROM doctor WHERE id = ? FOR UPDATE", [doctorId]);
  return rows.length > 0;
}

/** Lugares ocupados: invitaciones pendientes no vencidas más personas con vínculo vigente. */
export async function countOccupiedSeats(executor: Executor, doctorId: number, now: Date): Promise<number> {
  const [pending] = await executor.execute<RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM reception_invitation WHERE doctor_id = ? AND status = 'pending' AND expires_at > ?",
    [doctorId, now],
  );
  const [active] = await executor.execute<RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM reception_membership WHERE doctor_id = ? AND active_flag = 1",
    [doctorId],
  );
  return Number(pending[0]?.n) + Number(active[0]?.n);
}

export async function hasPendingInvitationFor(executor: Executor, doctorId: number, email: string, now: Date): Promise<boolean> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    "SELECT 1 AS ok FROM reception_invitation WHERE doctor_id = ? AND email_normalized = ? AND status = 'pending' AND expires_at > ? LIMIT 1",
    [doctorId, email, now],
  );
  return rows.length > 0;
}

export async function insertInvitation(
  executor: Executor,
  input: { doctorId: number; email: string; invitedByUserId: number; createdAt: Date; expiresAt: Date },
): Promise<number> {
  const [result] = await executor.execute<ResultSetHeader>(
    `INSERT INTO reception_invitation (doctor_id, email_normalized, status, invited_by_user_id, created_at, expires_at)
     VALUES (?, ?, 'pending', ?, ?, ?)`,
    [input.doctorId, input.email, input.invitedByUserId, input.createdAt, input.expiresAt],
  );
  return result.insertId;
}

export async function findInvitation(executor: Executor, id: number, lock = false): Promise<InvitationRecord | null> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT id, doctor_id, email_normalized, status, created_at, expires_at FROM reception_invitation WHERE id = ?${lock ? " FOR UPDATE" : ""}`,
    [id],
  );
  return rows[0] ? toInvitation(rows[0]) : null;
}

export async function listPendingInvitations(executor: Executor, doctorId: number, now: Date): Promise<InvitationRecord[]> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT id, doctor_id, email_normalized, status, created_at, expires_at FROM reception_invitation
      WHERE doctor_id = ? AND status = 'pending' AND expires_at > ? ORDER BY id`,
    [doctorId, now],
  );
  return rows.map(toInvitation);
}

export async function listActiveMembers(executor: Executor, doctorId: number): Promise<MemberRecord[]> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT m.id, m.reception_user_id, u.email, u.full_name, m.created_at
       FROM reception_membership m JOIN \`user\` u ON u.id = m.reception_user_id
      WHERE m.doctor_id = ? AND m.active_flag = 1 ORDER BY m.id`,
    [doctorId],
  );
  return rows.map((row) => ({
    membershipId: Number(row.id),
    receptionUserId: Number(row.reception_user_id),
    email: String(row.email),
    fullName: row.full_name === null ? null : String(row.full_name),
    createdAt: row.created_at as Date,
  }));
}

export async function insertMembership(
  executor: Executor,
  input: { doctorId: number; receptionUserId: number; createdAt: Date },
): Promise<number> {
  const [result] = await executor.execute<ResultSetHeader>(
    "INSERT INTO reception_membership (doctor_id, reception_user_id, active_flag, created_at) VALUES (?, ?, 1, ?)",
    [input.doctorId, input.receptionUserId, input.createdAt],
  );
  return result.insertId;
}

/** Vínculo vigente de una persona con un médico APROBADO. Es la comprobación que se repite en cada petición. */
export async function hasActiveMembership(executor: Executor, receptionUserId: number, doctorId: number): Promise<boolean> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT 1 AS ok FROM reception_membership m JOIN doctor d ON d.id = m.doctor_id
      WHERE m.reception_user_id = ? AND m.doctor_id = ? AND m.active_flag = 1 AND d.approval_status = 'approved' LIMIT 1`,
    [receptionUserId, doctorId],
  );
  return rows.length > 0;
}

/** Médicos aprobados con los que la persona tiene vínculo vigente. */
export async function listDoctorsForReception(
  executor: Executor,
  receptionUserId: number,
): Promise<{ doctorId: number; fullName: string }[]> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT d.id, d.full_name FROM reception_membership m JOIN doctor d ON d.id = m.doctor_id
      WHERE m.reception_user_id = ? AND m.active_flag = 1 AND d.approval_status = 'approved' ORDER BY d.full_name, d.id`,
    [receptionUserId],
  );
  return rows.map((row) => ({ doctorId: Number(row.id), fullName: String(row.full_name) }));
}

export async function logReceptionAction(
  executor: Executor,
  input: {
    actorUserId: number;
    doctorId: number;
    action: "invite" | "accept" | "revoke_invitation" | "remove" | "select_active_doctor";
    targetType?: string;
    targetId?: number;
    at: Date;
  },
): Promise<void> {
  await executor.execute(
    "INSERT INTO reception_action_log (actor_user_id, doctor_id, action, target_type, target_id, occurred_at) VALUES (?, ?, ?, ?, ?, ?)",
    [input.actorUserId, input.doctorId, input.action, input.targetType ?? null, input.targetId ?? null, input.at],
  );
}
