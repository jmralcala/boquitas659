import type { RowDataPacket } from "mysql2/promise";
import type { Db } from "../../db/pool.js";
import { NotFoundError } from "../../http/errors.js";
import type { Clock } from "../../lib/clock.js";
import { createPatientContext } from "../../lib/tenant.js";
import { enqueueEmail } from "../../mail/outbox.js";
import { logCalendarAction } from "../calendar/action-log.js";
import { cancelBookedAppointment } from "../calendar/appointment-repository.js";
import { listAppointmentsForPatients } from "./account-appointments.js";
import { withCalendarLock } from "../calendar/calendar-lock.js";
import {
  findAccountByUserId,
  findAccountEmail,
  listAccountPatientIds,
  listAccountPatientIdsLinkedToDoctor,
  listActiveOffices,
  revokeAccountLinks,
  type ActiveOffice,
} from "../patients/patient-repository.js";
import { findDoctorAccountEmail } from "./site-repository.js";

export type OfficeItem = ActiveOffice;

export interface OfficesDeps {
  db: Db;
  clock: Clock;
}

async function accountIdOf(db: Pick<Db, "execute">, userId: number): Promise<number> {
  const account = await findAccountByUserId(db, userId);
  if (!account) throw new NotFoundError();
  return account.id;
}

/** «Mis consultorios»: los que tienen un vínculo activo con alguna persona de la cuenta. */
export async function listOffices(db: Pick<Db, "execute">, userId: number): Promise<OfficeItem[]> {
  return listActiveOffices(db, await accountIdOf(db, userId));
}

/** Qué pasará al revocar: nombre del consultorio y cuántas citas futuras de la cuenta se cancelarán. `NotFoundError` sin vínculo activo. */
export async function previewRevocation(
  db: Pick<Db, "execute">,
  userId: number,
  doctorId: number,
  now: Date,
): Promise<{ doctorId: number; doctorName: string; futureAppointments: number }> {
  const accountId = await accountIdOf(db, userId);
  const ctx = createPatientContext(doctorId, userId);
  if ((await listAccountPatientIdsLinkedToDoctor(ctx, db, accountId)).length === 0) throw new NotFoundError();
  const [doctors] = await db.execute<RowDataPacket[]>("SELECT full_name FROM doctor WHERE id = ?", [doctorId]);
  if (!doctors[0]) throw new NotFoundError();
  const appointments = await listAppointmentsForPatients(db, await listAccountPatientIds(db, accountId), new Date(now.getTime() - 86_400_000));
  const future = appointments.filter((item) => item.doctorId === doctorId && item.status === "booked" && item.endUtc.getTime() > now.getTime());
  return { doctorId, doctorName: String(doctors[0].full_name), futureAppointments: future.length };
}

/**
 * La cuenta revoca su vínculo con un consultorio (opción A de la decisión de producto), TODO en una transacción bajo el
 * bloqueo del médico: cancela las citas futuras vigentes de todos los pacientes de la cuenta con ese consultorio (aviso al
 * médico por cada una y constancia al paciente), retira el acceso del consultorio al contacto (`revoked_at` en todos los
 * vínculos de la cuenta) y deja `link_revoked` en el registro. Las citas pasadas y los nombres se conservan. No está
 * sujeta al plazo de cancelación ni a su límite por hora: es una decisión sobre los datos del paciente.
 */
export async function revoke(deps: OfficesDeps, userId: number, doctorId: number): Promise<{ cancelled: number }> {
  const accountId = await accountIdOf(deps.db, userId);
  const ctx = createPatientContext(doctorId, userId);

  return withCalendarLock(ctx, deps.db, async (connection) => {
    const now = deps.clock.now();
    // Bajo el bloqueo: una segunda revocación (o una concurrente) ya no encuentra vínculo activo.
    if ((await listAccountPatientIdsLinkedToDoctor(ctx, connection, accountId)).length === 0) throw new NotFoundError();

    const patientIds = await listAccountPatientIds(connection, accountId);
    const candidates = await listAppointmentsForPatients(connection, patientIds, new Date(now.getTime() - 86_400_000));
    const future = candidates.filter((item) => item.doctorId === doctorId && item.status === "booked" && item.endUtc.getTime() > now.getTime());

    const patientEmail = await findAccountEmail(connection, userId);
    const doctorEmail = await findDoctorAccountEmail(ctx, connection);
    let cancelled = 0;
    for (const item of future) {
      if (!(await cancelBookedAppointment(ctx, connection, item.id, now))) continue;
      cancelled += 1;
      await logCalendarAction(ctx, connection, { action: "appointment_cancelled", outcome: "ok", appointmentId: item.id, at: now });
      if (patientEmail) await enqueueEmail(connection, { template: "appointment_cancelled_by_patient", to: patientEmail, payload: { appointmentId: item.id } }, deps.clock);
      if (doctorEmail) await enqueueEmail(connection, { template: "doctor_appointment_cancelled", to: doctorEmail, payload: { appointmentId: item.id, reason: "revoked" } }, deps.clock);
    }

    await revokeAccountLinks(ctx, connection, accountId, now);
    await logCalendarAction(ctx, connection, { action: "link_revoked", outcome: "ok", at: now });
    return { cancelled };
  });
}
