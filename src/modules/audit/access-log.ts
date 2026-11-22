import type { Pool, PoolConnection } from "mysql2/promise";

type Executor = Pick<Pool, "execute"> | Pick<PoolConnection, "execute">;

export interface PatientAccessEntry {
  actorUserId: number;
  actorRole: "doctor" | "reception";
  doctorId: number;
  patientId: number;
  outcome: "allowed" | "denied";
  at: Date;
}

/**
 * Registra el acceso al detalle de un paciente: quién, en nombre de qué médico, a qué paciente, con qué resultado y
 * cuándo. NUNCA guarda contenido del paciente. Los intentos denegados (paciente de otro médico o inexistente)
 * también se registran. La tabla es de solo anexar (disparadores en la base de datos).
 */
export async function logPatientAccess(executor: Executor, entry: PatientAccessEntry): Promise<void> {
  await executor.execute(
    `INSERT INTO patient_access_log (actor_user_id, actor_role, doctor_id, patient_id, outcome, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [entry.actorUserId, entry.actorRole, entry.doctorId, entry.patientId, entry.outcome, entry.at],
  );
}
