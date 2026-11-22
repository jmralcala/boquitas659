import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from "mysql2/promise";
import type { Db } from "../../db/pool.js";
import { systemClock, type Clock } from "../../lib/clock.js";
import type { UserRole } from "../auth/sessions.js";

export const LEGAL_TYPES = [
  "patient_privacy",
  "doctor_privacy",
  "reception_privacy",
  "reception_confidentiality",
  "terms_doctor",
] as const;
export type LegalType = (typeof LEGAL_TYPES)[number];

export function isLegalType(value: string): value is LegalType {
  return (LEGAL_TYPES as readonly string[]).includes(value);
}

export interface LegalDocument {
  id: number;
  type: LegalType;
  version: number;
  title: string;
  body: string;
  isProvisional: boolean;
  publishedAt: Date;
}

type Executor = Pick<Pool, "execute"> | Pick<PoolConnection, "execute">;

const APPLICABLE: Record<UserRole, readonly LegalType[]> = {
  patient: ["patient_privacy"],
  doctor: ["doctor_privacy", "terms_doctor"],
  reception: ["reception_privacy", "reception_confidentiality"],
  support: [],
};

export interface LegalService {
  /** Publica una versión nueva (número consecutivo por tipo). */
  publish(input: { type: LegalType; title: string; body: string; isProvisional: boolean }): Promise<LegalDocument>;
  latest(type: LegalType): Promise<LegalDocument | null>;
  get(type: LegalType, version: number): Promise<LegalDocument | null>;
  /** Registra una aceptación (solo anexar). */
  recordAcceptance(
    input: { userId: number; documentId: number; onBehalfOfPatientId?: number; ipHash?: string },
    executor?: Executor,
  ): Promise<void>;
  /** Tipos de documento que aplican a un rol. */
  applicableTypes(role: UserRole): readonly LegalType[];
  /** Últimas versiones aplicables al rol que el usuario aún no ha aceptado. */
  pendingFor(userId: number, role: UserRole): Promise<LegalDocument[]>;
}

function toDocument(row: RowDataPacket): LegalDocument {
  return {
    id: Number(row.id),
    type: row.type as LegalType,
    version: Number(row.version),
    title: String(row.title),
    body: String(row.body),
    isProvisional: row.is_provisional === 1,
    publishedAt: row.published_at as Date,
  };
}

export function createLegalService(db: Db, clock: Clock = systemClock): LegalService {
  const service: LegalService = {
    async publish(input) {
      // El índice único (type, version) garantiza que no se repitan números: ante una colisión
      // con otra publicación simultánea se recalcula la versión y se reintenta (sin bloqueos que causen deadlocks).
      for (let attempt = 1; ; attempt += 1) {
        const [rows] = await db.execute<RowDataPacket[]>(
          "SELECT COALESCE(MAX(version), 0) AS v FROM legal_document WHERE type = ?",
          [input.type],
        );
        const version = Number(rows[0]?.v) + 1;
        const publishedAt = clock.now();
        try {
          const [result] = await db.execute<ResultSetHeader>(
            `INSERT INTO legal_document (type, version, title, body, is_provisional, published_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [input.type, version, input.title, input.body, input.isProvisional ? 1 : 0, publishedAt],
          );
          return {
            id: result.insertId,
            type: input.type,
            version,
            title: input.title,
            body: input.body,
            isProvisional: input.isProvisional,
            publishedAt,
          };
        } catch (error) {
          const duplicate = (error as { code?: string }).code === "ER_DUP_ENTRY";
          if (!duplicate || attempt >= 10) throw error;
        }
      }
    },

    async latest(type) {
      const [rows] = await db.execute<RowDataPacket[]>(
        "SELECT * FROM legal_document WHERE type = ? ORDER BY version DESC LIMIT 1",
        [type],
      );
      return rows[0] ? toDocument(rows[0]) : null;
    },

    async get(type, version) {
      const [rows] = await db.execute<RowDataPacket[]>(
        "SELECT * FROM legal_document WHERE type = ? AND version = ?",
        [type, version],
      );
      return rows[0] ? toDocument(rows[0]) : null;
    },

    async recordAcceptance(input, executor = db) {
      await executor.execute(
        `INSERT INTO consent_acceptance (user_id, on_behalf_of_patient_id, legal_document_id, accepted_at, ip_hash)
         VALUES (?, ?, ?, ?, ?)`,
        [input.userId, input.onBehalfOfPatientId ?? null, input.documentId, clock.now(), input.ipHash ?? null],
      );
    },

    applicableTypes(role) {
      return APPLICABLE[role];
    },

    async pendingFor(userId, role) {
      const pending: LegalDocument[] = [];
      for (const type of APPLICABLE[role]) {
        const latest = await service.latest(type);
        if (!latest) continue;
        const [rows] = await db.execute<RowDataPacket[]>(
          "SELECT 1 AS ok FROM consent_acceptance WHERE user_id = ? AND legal_document_id = ? AND on_behalf_of_patient_id IS NULL LIMIT 1",
          [userId, latest.id],
        );
        if (rows.length === 0) pending.push(latest);
      }
      return pending;
    },
  };
  return service;
}
