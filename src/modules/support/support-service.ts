import type { RowDataPacket } from "mysql2/promise";
import type { Db } from "../../db/pool.js";
import { withTransaction } from "../../db/tx.js";
import { AppError, ConflictError, NotFoundError, ValidationError } from "../../http/errors.js";
import { systemClock, type Clock } from "../../lib/clock.js";
import { enqueueEmail } from "../../mail/outbox.js";
import { appendSupportAction } from "./action-log.js";
import {
  findDoctorById,
  insertReview,
  listDoctors,
  searchDoctors,
  type ApprovalStatus,
  type DoctorListFilter,
  type Doctor,
} from "../doctors/doctor-repository.js";

export const TRIAL_DAYS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_REASON = 500;

/** Lo que soporte ve de un médico: su ficha, su micrositio y SOLO el número de citas futuras (nunca datos de pacientes). */
export interface DoctorOverview {
  doctor: Doctor;
  site: { slug: string; status: "draft" | "published" | "unpublished" } | null;
  futureAppointments: number;
}

export interface SupportService {
  list(status: ApprovalStatus | "all"): Promise<Doctor[]>;
  /** Lista del panel por estado de aprobación u operativo, con búsqueda por nombre o correo del médico. */
  search(filter: { estado: DoctorListFilter; q?: string }): Promise<Doctor[]>;
  overview(doctorId: number): Promise<DoctorOverview | null>;
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
    search: (filter) => searchDoctors(db, filter),

    async overview(doctorId) {
      const doctor = await findDoctorById(db, doctorId);
      if (!doctor) return null;
      const [sites] = await db.execute<RowDataPacket[]>("SELECT slug, status FROM doctor_site WHERE doctor_id = ?", [doctor.id]);
      // Solo se cuentan las citas: soporte no ve quién las tiene.
      const [counts] = await db.execute<RowDataPacket[]>(
        "SELECT COUNT(*) AS n FROM appointment WHERE doctor_id = ? AND status = 'booked' AND start_utc > ?",
        [doctor.id, clock.now()],
      );
      const site = sites[0];
      return {
        doctor,
        site: site ? { slug: String(site.slug), status: site.status as "draft" | "published" | "unpublished" } : null,
        futureAppointments: Number(counts[0]?.n ?? 0),
      };
    },
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
          await appendSupportAction(connection, { supportUserId, action: "approve", targetType: "doctor", targetId: doctor.id, reason: null, occurredAt: now });
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
          await appendSupportAction(connection, { supportUserId, action: "reject", targetType: "doctor", targetId: doctor.id, reason: text, occurredAt: now });
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
          // Doble envío: si la cédula ya está liberada no hay nada que hacer (ni historial ni aviso duplicados).
          if (doctor.cedulaNormalized === null) return;
          // Una cuenta suspendida tiene al usuario deshabilitado: liberada la cédula no podría entrar a reenviarla ni soporte reactivarla.
          if (doctor.accountState === "suspended") {
            throw new ConflictError("La cuenta está suspendida: reactívala antes de liberar su cédula.", "invalid_state");
          }
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
          // Aviso con el mensaje fijo guardado arriba (`doctor_rejected` lo lee); nunca lleva el motivo interno.
          await enqueueEmail(connection, { template: "doctor_rejected", to: doctor.email, payload: { doctorId: doctor.id } }, clock);
          await appendSupportAction(connection, { supportUserId, action: "release_cedula", targetType: "doctor", targetId: doctor.id, reason: text, occurredAt: now });
        },
        false,
      );
    },
  };
}
