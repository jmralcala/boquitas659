import type { Pool, PoolConnection } from "mysql2/promise";
import { NotFoundError } from "../../http/errors.js";

type Executor = Pick<Pool, "execute"> | Pick<PoolConnection, "execute">;

/**
 * Crea la relación médico-paciente (unidad de aislamiento). Es idempotente. Uso interno: la reserva de la
 * feature 3 la invocará cuando un paciente agende con un médico; aquí solo la ejercen las pruebas.
 */
export async function linkPatientToDoctor(executor: Executor, doctorId: number, patientId: number): Promise<void> {
  try {
    await executor.execute(
      "INSERT INTO doctor_patient (doctor_id, patient_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE doctor_id = doctor_id",
      [doctorId, patientId],
    );
  } catch (error) {
    // 1452 = la fila referenciada (médico o paciente) no existe.
    if ((error as { errno?: number }).errno === 1452) throw new NotFoundError();
    throw error;
  }
}
