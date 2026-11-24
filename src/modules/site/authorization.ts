import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { LegalReviewPendingError } from "../../http/errors.js";
import type { TenantContext } from "../../lib/tenant.js";
import { logCalendarAction } from "../calendar/action-log.js";
import { latestLinkRevocation } from "../patients/patient-repository.js";

type Executor = Pick<Pool, "execute"> | Pick<PoolConnection, "execute">;

/**
 * ¿La cuenta tiene una autorización ACTIVA para compartir los datos de contacto de sus pacientes con este consultorio?
 * Activa = existe una autorización y es posterior a la última revocación del vínculo (si la hubo). Un vínculo creado
 * por el personal sin autorización del paciente NO cuenta como autorizado.
 */
export async function hasActiveAuthorization(ctx: TenantContext, executor: Executor, accountId: number): Promise<boolean> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    "SELECT MAX(accepted_at) AS last_authorized FROM data_authorization WHERE account_id = ? AND doctor_id = ?",
    [accountId, ctx.doctorId],
  );
  const lastAuthorized = rows[0]?.last_authorized;
  if (!(lastAuthorized instanceof Date)) return false;
  const lastRevoked = await latestLinkRevocation(ctx, executor, accountId);
  return lastRevoked === null || lastAuthorized.getTime() > lastRevoked.getTime();
}

/**
 * Registra (solo anexar) que quien tiene la sesión autoriza a este consultorio a ver los datos de contacto de los
 * pacientes de su cuenta, con la versión VIGENTE del aviso de privacidad, y deja la acción `data_authorized` en el
 * registro de la agenda. Debe llamarse en la misma transacción que la cita (`withCalendarLock`).
 */
export async function recordAuthorization(
  ctx: TenantContext,
  executor: Executor,
  input: { accountId: number; now: Date },
): Promise<void> {
  const [documents] = await executor.execute<RowDataPacket[]>(
    "SELECT id FROM legal_document WHERE type = 'patient_privacy' ORDER BY version DESC LIMIT 1",
  );
  const documentId = documents[0] ? Number(documents[0].id) : null;
  if (documentId === null) throw new LegalReviewPendingError();

  await executor.execute(
    "INSERT INTO data_authorization (account_id, doctor_id, given_by_user_id, legal_document_id, accepted_at) VALUES (?, ?, ?, ?, ?)",
    [input.accountId, ctx.doctorId, ctx.actor.userId, documentId, input.now],
  );
  await logCalendarAction(ctx, executor, { action: "data_authorized", outcome: "ok", at: input.now });
}
