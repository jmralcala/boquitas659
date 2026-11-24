import type { PoolConnection } from "mysql2/promise";
import type { Db } from "../../db/pool.js";
import { withTransaction } from "../../db/tx.js";
import { ConflictError, NotFoundError } from "../../http/errors.js";
import { systemClock, type Clock } from "../../lib/clock.js";
import { enqueueEmail } from "../../mail/outbox.js";
import { findDoctorById, type AccountState, type Doctor } from "../doctors/doctor-repository.js";
import type { SessionService } from "../auth/sessions.js";
import { appendSupportAction, type SupportAction } from "./action-log.js";
import { canTransition, nextState, type StateAction } from "./state-rules.js";

export interface StateChangeInput {
  doctorId: number;
  supportUserId: number;
  reason: string;
  /** Estado que la persona de soporte estaba viendo: si ya cambió, la acción se rechaza (409 `state_changed`). */
  from: AccountState;
}

export interface AccountStateService {
  suspend(input: StateChangeInput): Promise<void>;
  setReadOnly(input: StateChangeInput): Promise<void>;
  reactivate(input: StateChangeInput): Promise<void>;
}

const NOTICE: Readonly<Record<StateAction, string>> = {
  suspend: "doctor_account_suspended",
  read_only: "doctor_account_read_only",
  reactivate: "doctor_account_reactivated",
};

/**
 * Cambios del estado operativo de la cuenta de un médico (suspender, solo lectura, reactivar). Cada uno es una sola
 * transacción: bloquea la fila del médico, comprueba que siga aprobada y en el estado que soporte vio, aplica el cambio
 * (en una suspensión también deshabilita al usuario y revoca sus sesiones), escribe el historial y encola el aviso fijo.
 * Dos acciones simultáneas se serializan por ese bloqueo: la segunda ve el estado nuevo y se rechaza sin duplicar nada.
 */
export function createAccountStateService(deps: { db: Db; sessions: Pick<SessionService, "revokeAllForUser">; clock?: Clock }): AccountStateService {
  const clock = deps.clock ?? systemClock;

  async function apply(action: StateAction, input: StateChangeInput): Promise<void> {
    const reason = input.reason.trim();
    await withTransaction(deps.db, async (connection: PoolConnection) => {
      const doctor: Doctor | null = await findDoctorById(connection, input.doctorId, true);
      if (!doctor) throw new NotFoundError();
      if (doctor.approvalStatus !== "approved") {
        throw new ConflictError("Solo se puede cambiar el estado de una cuenta aprobada.", "invalid_state");
      }
      if (doctor.accountState !== input.from) {
        throw new ConflictError("El estado de la cuenta cambió mientras lo revisabas. Revisa y vuelve a intentarlo.", "state_changed");
      }
      if (!canTransition(doctor.accountState, action)) {
        throw new ConflictError("Ese cambio no corresponde al estado actual de la cuenta.", "invalid_state");
      }
      const target = nextState(doctor.accountState, action);
      const now = clock.now();

      await connection.execute(
        "UPDATE doctor SET account_state = ?, account_state_changed_at = ?, account_state_changed_by = ? WHERE id = ?",
        [target, now, input.supportUserId, doctor.id],
      );
      // Suspender cierra el acceso del médico (inicio de sesión y sesiones abiertas); reactivar lo restablece.
      if (target === "suspended") {
        await connection.execute("UPDATE `user` SET status = 'disabled' WHERE id = ?", [doctor.userId]);
        await deps.sessions.revokeAllForUser(doctor.userId, 0, connection);
      } else if (doctor.accountState === "suspended") {
        await connection.execute("UPDATE `user` SET status = 'active' WHERE id = ?", [doctor.userId]);
      }

      const logged: SupportAction = action;
      await appendSupportAction(connection, { supportUserId: input.supportUserId, action: logged, targetType: "doctor", targetId: doctor.id, reason, occurredAt: now });
      await enqueueEmail(connection, { template: NOTICE[action], to: doctor.email, payload: { doctorId: doctor.id } }, clock);
    });
  }

  return {
    suspend: (input) => apply("suspend", input),
    setReadOnly: (input) => apply("read_only", input),
    reactivate: (input) => apply("reactivate", input),
  };
}
