import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { NotFoundError } from "../../http/errors.js";
import type { TenantContext } from "../../lib/tenant.js";
import { accountHasRevokedLink, reactivateAccountLinks } from "./patient-repository.js";

type Executor = Pick<Pool, "execute"> | Pick<PoolConnection, "execute">;

export interface LinkOptions {
  /** Quién crea el vínculo: el propio paciente al reservar, o el consultorio al agendarle una cita. */
  origin: "patient" | "office";
  createdByUserId: number | null;
}

export interface LinkResult {
  /** Se creó una fila nueva (el paciente no tenía vínculo con este médico). */
  created: boolean;
  /** Existía un vínculo revocado y el propio paciente lo reactivó. */
  reactivated: boolean;
}

/**
 * Crea la relación médico-paciente (unidad de aislamiento). Es idempotente. Debe llamarse dentro de `withCalendarLock`.
 *
 * - Si la cuenta del paciente REVOCÓ el vínculo con este médico, el consultorio (`origin: "office"`) no puede
 *   reactivarlo ni crear uno nuevo para otra persona de la cuenta: responde como un paciente inalcanzable
 *   (`NotFoundError`). Solo el propio paciente (`origin: "patient"`), al reservar él mismo, lo reactiva.
 * - Un vínculo vigente no cambia (se conserva su origen).
 */
export async function linkPatientToDoctor(
  ctx: TenantContext,
  executor: Executor,
  patientId: number,
  options: LinkOptions = { origin: "office", createdByUserId: null },
): Promise<LinkResult> {
  const accountRevoked = await accountHasRevokedLink(ctx, executor, patientId);
  if (accountRevoked && options.origin !== "patient") throw new NotFoundError();

  let reactivated = false;
  if (accountRevoked) {
    await reactivateAccountLinks(ctx, executor, patientId, options.createdByUserId);
    reactivated = true;
  }

  const [existing] = await executor.execute<RowDataPacket[]>("SELECT patient_id FROM doctor_patient WHERE doctor_id = ? AND patient_id = ?", [
    ctx.doctorId,
    patientId,
  ]);
  if (existing[0]) return { created: false, reactivated };

  try {
    await executor.execute("INSERT INTO doctor_patient (doctor_id, patient_id, origin, created_by_user_id) VALUES (?, ?, ?, ?)", [
      ctx.doctorId,
      patientId,
      options.origin,
      options.createdByUserId,
    ]);
  } catch (error) {
    // 1452 = la fila referenciada (médico o paciente) no existe.
    if ((error as { errno?: number }).errno === 1452) throw new NotFoundError();
    throw error;
  }
  return { created: true, reactivated };
}
