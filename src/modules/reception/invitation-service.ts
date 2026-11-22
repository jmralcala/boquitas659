import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { z } from "zod";
import type { Db } from "../../db/pool.js";
import { withTransaction } from "../../db/tx.js";
import { AppError, ForbiddenError, InvalidLinkError, LegalReviewPendingError, NotFoundError, ValidationError } from "../../http/errors.js";
import { parseInput } from "../../http/validate.js";
import { systemClock, type Clock } from "../../lib/clock.js";
import { normalizeEmail } from "../../lib/normalize.js";
import { enqueueEmail } from "../../mail/outbox.js";
import type { PasswordHasher } from "../auth/password-hasher.js";
import { validatePassword } from "../auth/password-policy.js";
import { INVITATION_TTL_MS, type OneTimeTokenService } from "../auth/one-time-tokens.js";
import { findDoctorById } from "../doctors/doctor-repository.js";
import type { LegalService } from "../legal/legal-service.js";
import {
  MAX_RECEPTION_PER_DOCTOR,
  countOccupiedSeats,
  findInvitation,
  hasPendingInvitationFor,
  insertInvitation,
  insertMembership,
  lockDoctorRow,
  logReceptionAction,
} from "./reception-repository.js";

export interface InvitationDeps {
  db: Db;
  tokens: OneTimeTokenService;
  legal: LegalService;
  hasher: PasswordHasher;
  clock?: Clock;
  /** En producción, mientras los avisos sean provisionales no se aceptan invitaciones (FR-023). */
  blockProvisional?: boolean;
}

export interface InvitationSummary {
  invitationId: number;
  doctorName: string;
  email: string;
  /** La persona ya tiene cuenta de recepción: no se le pide nombre ni contraseña. */
  existingAccount: boolean;
}

const required = "Este campo es obligatorio.";
const acceptSchema = z.object({
  fullName: z.string().trim().max(200).optional(),
  password: z.string().max(256).optional(),
  acceptPrivacy: z.literal("yes", { error: "Debes aceptar el aviso de privacidad para continuar." }),
  acceptConfidentiality: z.literal("yes", { error: "Debes aceptar el compromiso de confidencialidad para continuar." }),
});

// Mensaje genérico: no revela si el correo pertenece a otra cuenta ni de qué rol.
const GENERIC_EMAIL = "No pudimos usar ese correo para una invitación.";
const LIMIT_MESSAGE = `Ya tienes ${MAX_RECEPTION_PER_DOCTOR} personas de recepción (las invitaciones pendientes cuentan). Retira a una persona o revoca una invitación para invitar a otra.`;

export interface InvitationService {
  invite(doctorId: number, invitedByUserId: number, rawEmail: string): Promise<{ invitationId: number }>;
  revoke(doctorId: number, actorUserId: number, invitationId: number): Promise<void>;
  /** Resumen del enlace sin consumirlo; `null` si venció, ya se usó o la invitación no está vigente. */
  peek(token: string): Promise<InvitationSummary | null>;
  accept(token: string, raw: unknown): Promise<{ userId: number; isNewAccount: boolean }>;
}

export function createInvitationService(deps: InvitationDeps): InvitationService {
  const clock = deps.clock ?? systemClock;

  async function accountRoleOf(email: string): Promise<{ id: number; role: string } | null> {
    const [rows] = await deps.db.execute<RowDataPacket[]>("SELECT id, role FROM `user` WHERE email_normalized = ?", [email]);
    return rows[0] ? { id: Number(rows[0].id), role: String(rows[0].role) } : null;
  }

  const service: InvitationService = {
    async invite(doctorId, invitedByUserId, rawEmail) {
      const email = normalizeEmail(rawEmail);
      if (email === null) throw new ValidationError({ email: ["Escribe un correo válido."] });

      const doctor = await findDoctorById(deps.db, doctorId);
      if (!doctor || doctor.approvalStatus !== "approved") throw new ForbiddenError("Tu cuenta aún no está aprobada.");

      const existing = await accountRoleOf(email);
      if (existing && existing.role !== "reception") throw new ValidationError({ email: [GENERIC_EMAIL] });

      return withTransaction(deps.db, async (connection) => {
        // Se bloquea la fila del médico: invitaciones simultáneas se serializan y el conteo nunca se pasa de 2.
        if (!(await lockDoctorRow(connection, doctorId))) throw new NotFoundError();
        const now = clock.now();

        if (await hasPendingInvitationFor(connection, doctorId, email, now)) {
          throw new ValidationError({ email: ["Ya hay una invitación pendiente para ese correo."] });
        }
        if (existing) {
          const [active] = await connection.execute<RowDataPacket[]>(
            "SELECT 1 AS ok FROM reception_membership WHERE doctor_id = ? AND reception_user_id = ? AND active_flag = 1",
            [doctorId, existing.id],
          );
          if (active.length > 0) throw new ValidationError({ email: ["Esa persona ya trabaja contigo."] });
        }
        if ((await countOccupiedSeats(connection, doctorId, now)) >= MAX_RECEPTION_PER_DOCTOR) {
          throw new AppError(409, "limit_reached", LIMIT_MESSAGE);
        }

        const invitationId = await insertInvitation(connection, {
          doctorId,
          email,
          invitedByUserId,
          createdAt: now,
          expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
        });
        await logReceptionAction(connection, { actorUserId: invitedByUserId, doctorId, action: "invite", targetType: "invitation", targetId: invitationId, at: now });
        // El token del enlace se crea al enviar el correo (outbox); aquí solo se encola.
        await enqueueEmail(connection, { template: "reception_invitation", to: email, payload: { invitationId } }, clock);
        return { invitationId };
      });
    },

    async revoke(doctorId, actorUserId, invitationId) {
      await withTransaction(deps.db, async (connection) => {
        const invitation = await findInvitation(connection, invitationId, true);
        if (!invitation || invitation.doctorId !== doctorId) throw new NotFoundError();
        if (invitation.status !== "pending") throw new AppError(409, "invalid_state", "Esa invitación ya no está pendiente.");
        const now = clock.now();
        await connection.execute("UPDATE reception_invitation SET status = 'revoked' WHERE id = ?", [invitationId]);
        // El enlace deja de servir aunque nadie lo haya abierto.
        await connection.execute(
          "UPDATE one_time_token SET used_at = ? WHERE invitation_id = ? AND purpose = 'reception_invite' AND used_at IS NULL",
          [now, invitationId],
        );
        await logReceptionAction(connection, { actorUserId, doctorId, action: "revoke_invitation", targetType: "invitation", targetId: invitationId, at: now });
      });
    },

    async peek(token) {
      const subject = await deps.tokens.peek(token, "reception_invite");
      if (subject?.invitationId == null) return null;
      const invitation = await findInvitation(deps.db, subject.invitationId);
      if (!invitation || invitation.status !== "pending" || invitation.expiresAt.getTime() <= clock.now().getTime()) return null;
      const doctor = await findDoctorById(deps.db, invitation.doctorId);
      if (!doctor || doctor.approvalStatus !== "approved") return null;
      const account = await accountRoleOf(invitation.email);
      return {
        invitationId: invitation.id,
        doctorName: doctor.fullName,
        email: invitation.email,
        existingAccount: account?.role === "reception",
      };
    },

    async accept(token, raw) {
      // Antes de tocar el token: si se bloquea, la invitación sigue vigente para cuando los textos estén revisados.
      if (deps.blockProvisional && (await deps.legal.hasProvisional(["reception_privacy", "reception_confidentiality"]))) {
        throw new LegalReviewPendingError();
      }
      const summary = await service.peek(token);
      if (!summary) throw new InvalidLinkError();

      const input = parseInput(acceptSchema, raw ?? {});
      const account = await accountRoleOf(summary.email);
      if (account && account.role !== "reception") throw new ValidationError({ _: [GENERIC_EMAIL] });

      const fields: Record<string, string[]> = {};
      let passwordHash: string | null = null;
      if (!account) {
        if (!input.fullName || input.fullName.length < 2) fields.fullName = ["Escribe tu nombre completo."];
        if (!input.password) {
          fields.password = [required];
        } else {
          const check = validatePassword(input.password, { email: summary.email, name: input.fullName });
          if (!check.ok) fields.password = [check.message];
        }
      }
      if (Object.keys(fields).length > 0) throw new ValidationError(fields);
      if (!account && input.password) passwordHash = await deps.hasher.hash(input.password);

      const [privacy, confidentiality] = await Promise.all([
        deps.legal.latest("reception_privacy"),
        deps.legal.latest("reception_confidentiality"),
      ]);
      if (!privacy || !confidentiality) throw new Error("Faltan los documentos legales de recepción.");

      try {
        return await withTransaction(deps.db, async (connection) => {
          // Se consume dentro de la transacción: si algo falla el enlace sigue vigente; con envíos simultáneos solo uno gana.
          const subject = await deps.tokens.consume(token, "reception_invite", connection);
          if (subject?.invitationId == null) throw new InvalidLinkError();
          const invitation = await findInvitation(connection, subject.invitationId, true);
          const now = clock.now();
          if (!invitation || invitation.status !== "pending" || invitation.expiresAt.getTime() <= now.getTime()) {
            throw new InvalidLinkError();
          }

          let userId: number;
          let isNewAccount = false;
          if (account) {
            userId = account.id;
          } else {
            const [user] = await connection.execute<ResultSetHeader>(
              "INSERT INTO `user` (email, email_normalized, role, password_hash, password_changed_at, full_name, created_at) VALUES (?, ?, 'reception', ?, ?, ?, ?)",
              [invitation.email, invitation.email, passwordHash, now, input.fullName ?? null, now],
            );
            userId = user.insertId;
            isNewAccount = true;
          }

          for (const document of [privacy, confidentiality]) {
            await deps.legal.recordAcceptance({ userId, documentId: document.id }, connection);
          }
          await insertMembership(connection, { doctorId: invitation.doctorId, receptionUserId: userId, createdAt: now });
          await connection.execute("UPDATE reception_invitation SET status = 'accepted', accepted_at = ? WHERE id = ?", [now, invitation.id]);
          await logReceptionAction(connection, { actorUserId: userId, doctorId: invitation.doctorId, action: "accept", targetType: "invitation", targetId: invitation.id, at: now });

          const doctor = await findDoctorById(connection, invitation.doctorId);
          if (doctor) {
            await enqueueEmail(connection, { template: "reception_joined", to: doctor.email, payload: { invitationId: invitation.id } }, clock);
          }
          return { userId, isNewAccount };
        });
      } catch (error) {
        if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
          // Correo registrado por otra vía mientras tanto, o vínculo ya vigente: mensaje genérico.
          throw new ValidationError({ _: [GENERIC_EMAIL] });
        }
        throw error;
      }
    },
  };
  return service;
}
