import type { RowDataPacket } from "mysql2/promise";
import type { Db } from "../../db/pool.js";
import { withTransaction } from "../../db/tx.js";
import { ForbiddenError, NotFoundError } from "../../http/errors.js";
import { systemClock, type Clock } from "../../lib/clock.js";
import { enqueueEmail } from "../../mail/outbox.js";
import type { SessionService } from "../auth/sessions.js";
import {
  hasActiveMembership,
  listActiveMembers,
  listDoctorsForReception,
  listPendingInvitations,
  logReceptionAction,
  type InvitationRecord,
  type MemberRecord,
} from "./reception-repository.js";

export interface MembershipDeps {
  db: Db;
  sessions: SessionService;
  clock?: Clock;
}

export interface MembershipService {
  listActive(doctorId: number): Promise<MemberRecord[]>;
  listPending(doctorId: number): Promise<InvitationRecord[]>;
  /** Retira a una persona: su acceso con este médico se corta al instante (también las sesiones abiertas). */
  remove(doctorId: number, actorUserId: number, membershipId: number): Promise<void>;
  /** Médicos aprobados con vínculo vigente (para elegir con cuál trabaja la sesión). */
  doctorsFor(receptionUserId: number): Promise<{ doctorId: number; fullName: string }[]>;
  /** Solo se puede activar un médico con vínculo vigente. */
  selectActiveDoctor(sessionId: number, receptionUserId: number, doctorId: number, options?: { log?: boolean }): Promise<void>;
}

export function createMembershipService(deps: MembershipDeps): MembershipService {
  const clock = deps.clock ?? systemClock;

  return {
    listActive: (doctorId) => listActiveMembers(deps.db, doctorId),
    listPending: (doctorId) => listPendingInvitations(deps.db, doctorId, clock.now()),

    async remove(doctorId, actorUserId, membershipId) {
      await withTransaction(deps.db, async (connection) => {
        const [rows] = await connection.execute<RowDataPacket[]>(
          `SELECT m.id, m.reception_user_id, u.email
             FROM reception_membership m JOIN \`user\` u ON u.id = m.reception_user_id
            WHERE m.id = ? AND m.doctor_id = ? AND m.active_flag = 1 FOR UPDATE`,
          [membershipId, doctorId],
        );
        const membership = rows[0];
        // Un vínculo ajeno o ya retirado se trata como inexistente.
        if (!membership) throw new NotFoundError();
        const now = clock.now();
        await connection.execute("UPDATE reception_membership SET revoked_at = ?, active_flag = NULL WHERE id = ?", [now, membershipId]);
        // Se cierran las sesiones de esa persona que trabajan con este médico; las demás no se tocan.
        await connection.execute(
          "UPDATE session SET revoked_at = ? WHERE user_id = ? AND active_doctor_id = ? AND revoked_at IS NULL",
          [now, membership.reception_user_id, doctorId],
        );
        await logReceptionAction(connection, { actorUserId, doctorId, action: "remove", targetType: "membership", targetId: membershipId, at: now });
        await enqueueEmail(connection, { template: "reception_removed", to: String(membership.email), payload: { doctorId } }, clock);
      });
    },

    doctorsFor: (receptionUserId) => listDoctorsForReception(deps.db, receptionUserId),

    async selectActiveDoctor(sessionId, receptionUserId, doctorId, options = {}) {
      if (!(await hasActiveMembership(deps.db, receptionUserId, doctorId))) throw new ForbiddenError();
      await deps.sessions.setActiveDoctor(sessionId, doctorId);
      if (options.log !== false) {
        await logReceptionAction(deps.db, { actorUserId: receptionUserId, doctorId, action: "select_active_doctor", at: clock.now() });
      }
    },
  };
}
