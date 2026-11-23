import { createHmac, timingSafeEqual } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import type { Db } from "../../db/pool.js";
import { TooManyAttemptsError } from "../../http/errors.js";
import type { Clock } from "../../lib/clock.js";
import { normalizeEmail } from "../../lib/normalize.js";
import type { TenantContext } from "../../lib/tenant.js";
import { listPatientsByAccount, listPatientsForDoctor } from "../patients/patient-repository.js";
import { countRecentLookups, logCalendarAction, oldestLookupSince } from "./action-log.js";
import { withCalendarLock } from "./calendar-lock.js";

/** Límites de la búsqueda por correo (research.md, decisión 5) y vigencia del boleto. */
export const LOOKUP_LIMITS = {
  perActor: 30,
  perDoctor: 60,
  windowMs: 60 * 60_000,
  ticketTtlMs: 15 * 60_000,
} as const;

export interface PickerDeps {
  db: Db;
  clock: Clock;
  /** Secreto de la aplicación (`SESSION_SECRET`); el prefijo de propósito del boleto lo separa de otros usos. */
  ticketSecret: string;
}

export interface LinkedPatient {
  patientId: number;
  fullName: string;
}

export interface LookupResult {
  patients: { patientId: number; fullName: string; ticket: string }[];
}

/** Pacientes ya vinculados con el médico (id y nombre; nada más). */
export async function listLinkedPatients(ctx: TenantContext, db: Db): Promise<LinkedPatient[]> {
  const patients = await listPatientsForDoctor(ctx, db);
  return patients.map((patient) => ({ patientId: patient.id, fullName: patient.fullName }));
}

function macFor(secret: string, ctx: TenantContext, patientId: number, expiresMs: number): string {
  return createHmac("sha256", secret)
    .update(`calendar-patient:${ctx.doctorId}:${ctx.actor.userId}:${patientId}:${expiresMs}`)
    .digest("base64url");
}

/**
 * Boleto firmado que autoriza a UNA persona a agendar a UN paciente aún no vinculado con ESTE médico. Se obtiene solo
 * al encontrar la cuenta por su correo exacto: sin él, recorrer identificadores numéricos permitiría vincular pacientes.
 */
export function issueTicket(secret: string, ctx: TenantContext, patientId: number, now: Date): string {
  const expiresMs = now.getTime() + LOOKUP_LIMITS.ticketTtlMs;
  return `${expiresMs}.${macFor(secret, ctx, patientId, expiresMs)}`;
}

export function verifyTicket(secret: string, ctx: TenantContext, patientId: number, ticket: string, now: Date): boolean {
  const parts = ticket.split(".");
  if (parts.length !== 2) return false;
  const [expiresText, mac] = parts;
  if (!expiresText || !mac || !/^\d{1,15}$/.test(expiresText)) return false;
  const expiresMs = Number(expiresText);
  if (now.getTime() > expiresMs) return false;
  const expected = Buffer.from(macFor(secret, ctx, patientId, expiresMs));
  const received = Buffer.from(mac);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/**
 * Busca la cuenta de paciente por su correo EXACTO y devuelve los nombres de sus pacientes (titular y menores) con un
 * boleto para cada uno. No devuelve teléfono ni fecha de nacimiento. Limitada por persona y por médico y registrada
 * (también si no hay resultado); un intento rechazado por el límite no se registra para no alargar la ventana.
 * El conteo, la búsqueda y el registro ocurren bajo el bloqueo del médico: una ráfaga de peticiones simultáneas no puede
 * pasar el límite (se serializan y cada una ve las anteriores ya registradas).
 * Riesgo aceptado: revela nombres y que la cuenta existe, igual que el alta de pacientes de la feature 1.
 */
export async function lookupPatientsByEmail(ctx: TenantContext, deps: PickerDeps, email: string): Promise<LookupResult> {
  return withCalendarLock(ctx, deps.db, async (connection) => {
    const now = deps.clock.now();
    const since = new Date(now.getTime() - LOOKUP_LIMITS.windowMs);
    const counts = await countRecentLookups(ctx, connection, since);
    const limitedByActor = counts.byActor >= LOOKUP_LIMITS.perActor;
    const limitedByDoctor = counts.byDoctor >= LOOKUP_LIMITS.perDoctor;
    if (limitedByActor || limitedByDoctor) {
      const oldestActor = limitedByActor ? await oldestLookupSince(ctx, connection, since, "actor") : null;
      const oldestDoctor = limitedByDoctor ? await oldestLookupSince(ctx, connection, since, "doctor") : null;
      const waits = [oldestActor, oldestDoctor]
        .filter((oldest): oldest is Date => oldest !== null)
        .map((oldest) => oldest.getTime() + LOOKUP_LIMITS.windowMs - now.getTime());
      throw new TooManyAttemptsError(Math.max(1000, ...waits));
    }

    const normalized = normalizeEmail(email);
    let patients: LookupResult["patients"] = [];
    if (normalized) {
      const [accounts] = await connection.execute<RowDataPacket[]>(
        `SELECT pa.id FROM \`user\` u JOIN patient_account pa ON pa.user_id = u.id
          WHERE u.email_normalized = ? AND u.role = 'patient' AND u.status = 'active'`,
        [normalized],
      );
      const accountId = accounts[0] ? Number(accounts[0].id) : null;
      if (accountId !== null) {
        const records = await listPatientsByAccount(connection, accountId);
        patients = records.map((record) => ({
          patientId: record.id,
          fullName: record.fullName,
          ticket: issueTicket(deps.ticketSecret, ctx, record.id, now),
        }));
      }
    }
    await logCalendarAction(ctx, connection, { action: "patient_lookup", outcome: patients.length > 0 ? "ok" : "rejected", at: now });
    return { patients };
  });
}
