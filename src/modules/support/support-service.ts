import type { Db } from "../../db/pool.js";
import { withTransaction } from "../../db/tx.js";
import { AppError, NotFoundError, ValidationError } from "../../http/errors.js";
import { systemClock, type Clock } from "../../lib/clock.js";
import { enqueueEmail } from "../../mail/outbox.js";
import {
  findDoctorById,
  insertReview,
  listDoctors,
  type ApprovalStatus,
  type Doctor,
} from "../doctors/doctor-repository.js";

export const TRIAL_DAYS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_REASON = 500;

export interface SupportService {
  list(status: ApprovalStatus | "all"): Promise<Doctor[]>;
  get(doctorId: number): Promise<Doctor | null>;
  /** `pending → approved`; la prueba de 5 días empieza en este instante. */
  approve(doctorId: number, supportUserId: number): Promise<void>;
  /** `pending → rejected` con motivo obligatorio. */
  reject(doctorId: number, supportUserId: number, reason: string): Promise<void>;
  /** Libera cédula y móvil (los deja en NULL) y deja la cuenta rechazada para que vuelva a enviarlos. */
  releaseCedula(doctorId: number, supportUserId: number, reason: string): Promise<void>;
}

function cleanReason(reason: string): string {
  const value = reason.trim();
  if (value.length === 0) throw new ValidationError({ reason: ["Escribe el motivo."] });
  if (value.length > MAX_REASON) {
    throw new ValidationError({ reason: [`El motivo no puede pasar de ${MAX_REASON} caracteres.`] });
  }
  return value;
}

const RELEASED_MESSAGE =
  "Soporte liberó tu cédula y tu móvil de emergencias. Vuelve a enviarlos para que revisemos tu solicitud.";

export function createSupportService(db: Db, clock: Clock = systemClock): SupportService {
  async function decide(
    doctorId: number,
    apply: (connection: Parameters<Parameters<typeof withTransaction>[1]>[0], doctor: Doctor) => Promise<void>,
    requirePending: boolean,
  ): Promise<void> {
    await withTransaction(db, async (connection) => {
      // Se bloquea la fila del médico: decisiones simultáneas se serializan y la segunda ve el estado ya cambiado.
      const doctor = await findDoctorById(connection, doctorId, true);
      if (!doctor) throw new NotFoundError();
      if (requirePending && doctor.approvalStatus !== "pending") {
        throw new AppError(409, "invalid_state", "Esta solicitud ya fue resuelta.");
      }
      await apply(connection, doctor);
    });
  }

  return {
    list: (status) => listDoctors(db, status),
    get: (doctorId) => findDoctorById(db, doctorId),

    async approve(doctorId, supportUserId) {
      await decide(
        doctorId,
        async (connection, doctor) => {
          const now = clock.now();
          await connection.execute(
            `UPDATE doctor SET approval_status = 'approved', rejection_reason = NULL, approved_at = ?, approved_by_user_id = ?,
                    trial_started_at = ?, trial_ends_at = ?
              WHERE id = ?`,
            [now, supportUserId, now, new Date(now.getTime() + TRIAL_DAYS * DAY_MS), doctor.id],
          );
          await insertReview(connection, {
            doctorId: doctor.id,
            decision: "approved",
            reason: null,
            decidedByUserId: supportUserId,
            decidedAt: now,
          });
          await enqueueEmail(connection, { template: "doctor_approved", to: doctor.email, payload: { doctorId: doctor.id } }, clock);
        },
        true,
      );
    },

    async reject(doctorId, supportUserId, reason) {
      const text = cleanReason(reason);
      await decide(
        doctorId,
        async (connection, doctor) => {
          const now = clock.now();
          await connection.execute("UPDATE doctor SET approval_status = 'rejected', rejection_reason = ? WHERE id = ?", [
            text,
            doctor.id,
          ]);
          await insertReview(connection, {
            doctorId: doctor.id,
            decision: "rejected",
            reason: text,
            decidedByUserId: supportUserId,
            decidedAt: now,
          });
          await enqueueEmail(connection, { template: "doctor_rejected", to: doctor.email, payload: { doctorId: doctor.id } }, clock);
        },
        true,
      );
    },

    async releaseCedula(doctorId, supportUserId, reason) {
      const text = cleanReason(reason);
      await decide(
        doctorId,
        async (connection, doctor) => {
          const now = clock.now();
          // El motivo interno queda solo en el historial de soporte; al médico se le muestra un mensaje fijo.
          await connection.execute(
            `UPDATE doctor SET cedula_number = NULL, cedula_normalized = NULL, emergency_mobile = NULL,
                    approval_status = 'rejected', rejection_reason = ?
              WHERE id = ?`,
            [RELEASED_MESSAGE, doctor.id],
          );
          await insertReview(connection, {
            doctorId: doctor.id,
            decision: "cedula_released",
            reason: text,
            decidedByUserId: supportUserId,
            decidedAt: now,
          });
        },
        false,
      );
    },
  };
}
