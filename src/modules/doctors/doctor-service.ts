import type { ResultSetHeader } from "mysql2/promise";
import { z } from "zod";
import type { Db } from "../../db/pool.js";
import { withTransaction } from "../../db/tx.js";
import { AppError, LegalReviewPendingError, NotFoundError, ValidationError } from "../../http/errors.js";
import { parseInput } from "../../http/validate.js";
import { systemClock, type Clock } from "../../lib/clock.js";
import { normalizeCedula, normalizeEmail, normalizeMxPhone } from "../../lib/normalize.js";
import { enqueueEmail } from "../../mail/outbox.js";
import type { PasswordHasher } from "../auth/password-hasher.js";
import { validatePassword } from "../auth/password-policy.js";
import type { LegalService } from "../legal/legal-service.js";
import { detectCedulaFileType, type CedulaStorage } from "./cedula-storage.js";
import { findDoctorByUserId, insertDoctor } from "./doctor-repository.js";

export interface DoctorServiceDeps {
  db: Db;
  hasher: PasswordHasher;
  legal: LegalService;
  cedulaStorage: CedulaStorage;
  clock?: Clock;
  supportEmail: string;
  /** En producción, mientras los avisos sean provisionales no se admiten registros (FR-023). */
  blockProvisional?: boolean;
}

const required = "Este campo es obligatorio.";

const registrationSchema = z.object({
  fullName: z.string({ error: required }).trim().min(3, "Escribe tu nombre completo.").max(200, "El nombre es demasiado largo."),
  email: z.string({ error: required }).trim().min(1, required).max(254, "El correo es demasiado largo."),
  password: z.string({ error: required }).min(1, required).max(256),
  cedulaNumber: z.string({ error: required }).trim().min(1, required),
  emergencyMobile: z.string({ error: required }).trim().min(1, required),
  officePhone: z.string().trim().optional(),
  acceptPrivacy: z.literal("yes", { error: "Debes aceptar el aviso de privacidad para continuar." }),
  acceptTerms: z.literal("yes", { error: "Debes aceptar los términos y condiciones para continuar." }),
  cedulaFile: z.instanceof(Buffer, { error: "Adjunta la foto o el PDF de tu cédula." }),
  idFile: z.instanceof(Buffer, { error: "Adjunta la foto o el PDF de tu identificación oficial." }),
});

const resubmitSchema = z.object({
  cedulaNumber: z.string().trim().optional(),
  emergencyMobile: z.string().trim().optional(),
  cedulaFile: z.instanceof(Buffer).optional(),
  idFile: z.instanceof(Buffer).optional(),
});

export type ResubmitInput = z.input<typeof resubmitSchema>;

const FILE_MESSAGES = {
  empty: "Adjunta la foto o el PDF de tu cédula.",
  size: "El archivo es demasiado grande (máximo 5 MB).",
  type: "El archivo debe ser una imagen JPEG, PNG o un PDF.",
} as const;

const ID_FILE_MESSAGES = {
  empty: "Adjunta la foto o el PDF de tu identificación oficial.",
  size: FILE_MESSAGES.size,
  type: FILE_MESSAGES.type,
} as const;

const DUPLICATE_MESSAGES: Record<string, { field: string; message: string }> = {
  uq_doctor_cedula: {
    field: "cedulaNumber",
    message: "Esta cédula ya está registrada en otra cuenta. Escribe a soporte para que la revisen.",
  },
  uq_doctor_mobile: {
    field: "emergencyMobile",
    message: "Este móvil ya está registrado en otra cuenta. Escribe a soporte si se trata de un error.",
  },
  uq_user_email_normalized: {
    field: "email",
    // Mensaje genérico: no revela si el correo pertenece a un paciente, médico u otro rol.
    message: "No pudimos usar ese correo. Si ya tienes una cuenta, inicia sesión.",
  },
};

/** Convierte una violación de índice único en un error de validación por campo; si no lo es, relanza. */
function rethrowDuplicate(error: unknown): never {
  const code = (error as { code?: string }).code;
  if (code === "ER_DUP_ENTRY") {
    const text = String((error as { sqlMessage?: string }).sqlMessage ?? "");
    for (const [key, info] of Object.entries(DUPLICATE_MESSAGES)) {
      if (text.includes(key)) throw new ValidationError({ [info.field]: [info.message] });
    }
  }
  throw error;
}

export interface DoctorService {
  register(raw: unknown): Promise<{ userId: number; doctorId: number }>;
  /** Reenvío de una solicitud rechazada (`rejected → pending`) sin crear otra cuenta. */
  resubmit(userId: number, raw: ResubmitInput): Promise<void>;
}

export function createDoctorService(deps: DoctorServiceDeps): DoctorService {
  const clock = deps.clock ?? systemClock;

  /** Borrar un archivo de cédula nunca debe ocultar el error que se está manejando. */
  async function removeQuietly(name: string): Promise<void> {
    try {
      await deps.cedulaStorage.remove(name);
    } catch {
      // el archivo huérfano lo recogerá una limpieza manual; el error original es el importante
    }
  }

  return {
    async register(raw) {
      if (deps.blockProvisional && (await deps.legal.hasProvisional(["doctor_privacy", "terms_doctor"]))) {
        throw new LegalReviewPendingError();
      }
      const input = parseInput(registrationSchema, raw ?? {});
      const fields: Record<string, string[]> = {};

      const email = normalizeEmail(input.email);
      if (email === null) fields.email = ["Escribe un correo válido."];

      const mobile = normalizeMxPhone(input.emergencyMobile);
      if (mobile === null) fields.emergencyMobile = ["Escribe un número de 10 dígitos."];

      const cedula = normalizeCedula(input.cedulaNumber);
      if (cedula === null) fields.cedulaNumber = ["La cédula debe tener 7 u 8 dígitos."];

      let officePhone: string | null = null;
      if (input.officePhone) {
        officePhone = normalizeMxPhone(input.officePhone);
        if (officePhone === null) fields.officePhone = ["Escribe un teléfono de 10 dígitos."];
      }

      const passwordCheck = validatePassword(input.password, { email: input.email, name: input.fullName });
      if (!passwordCheck.ok) fields.password = [passwordCheck.message];

      const fileCheck = detectCedulaFileType(input.cedulaFile);
      if (!fileCheck.ok) fields.cedulaFile = [FILE_MESSAGES[fileCheck.reason]];

      const idCheck = detectCedulaFileType(input.idFile);
      if (!idCheck.ok) fields.idFile = [ID_FILE_MESSAGES[idCheck.reason]];

      if (Object.keys(fields).length > 0 || email === null || mobile === null || cedula === null) {
        throw new ValidationError(fields);
      }

      const [privacy, terms] = await Promise.all([deps.legal.latest("doctor_privacy"), deps.legal.latest("terms_doctor")]);
      if (!privacy || !terms) throw new Error("Faltan los documentos legales de médicos.");

      const passwordHash = await deps.hasher.hash(input.password);
      // El archivo se guarda solo después de validar y de que el médico aceptó los avisos.
      const saved = await deps.cedulaStorage.save(input.cedulaFile);
      let savedId: { name: string; sha256: string };
      try {
        savedId = await deps.cedulaStorage.save(input.idFile);
      } catch (error) {
        await removeQuietly(saved.name);
        throw error;
      }
      try {
        return await withTransaction(deps.db, async (connection) => {
          const now = clock.now();
          const [user] = await connection.execute<ResultSetHeader>(
            "INSERT INTO `user` (email, email_normalized, role, password_hash, password_changed_at, created_at) VALUES (?, ?, 'doctor', ?, ?, ?)",
            [email, email, passwordHash, now, now],
          );
          const doctorId = await insertDoctor(connection, {
            userId: user.insertId,
            fullName: input.fullName,
            cedulaNumber: cedula,
            cedulaNormalized: cedula,
            cedulaFilePath: saved.name,
            cedulaFileSha256: saved.sha256,
            idFilePath: savedId.name,
            idFileSha256: savedId.sha256,
            emergencyMobile: mobile,
            officePhone,
            createdAt: now,
          });
          for (const document of [privacy, terms]) {
            await deps.legal.recordAcceptance({ userId: user.insertId, documentId: document.id }, connection);
          }
          await enqueueEmail(
            connection,
            { template: "support_new_doctor", to: deps.supportEmail, payload: { doctorId } },
            clock,
          );
          return { userId: user.insertId, doctorId };
        });
      } catch (error) {
        await removeQuietly(saved.name);
        await removeQuietly(savedId.name);
        return rethrowDuplicate(error);
      }
    },

    async resubmit(userId, raw) {
      const input = parseInput(resubmitSchema, raw ?? {});
      const fields: Record<string, string[]> = {};

      let cedula: string | null | undefined;
      if (input.cedulaNumber) {
        cedula = normalizeCedula(input.cedulaNumber);
        if (cedula === null) fields.cedulaNumber = ["La cédula debe tener 7 u 8 dígitos."];
      }
      let mobile: string | null | undefined;
      if (input.emergencyMobile) {
        mobile = normalizeMxPhone(input.emergencyMobile);
        if (mobile === null) fields.emergencyMobile = ["Escribe un número de 10 dígitos."];
      }
      if (input.cedulaFile && input.cedulaFile.length > 0) {
        const fileCheck = detectCedulaFileType(input.cedulaFile);
        if (!fileCheck.ok) fields.cedulaFile = [FILE_MESSAGES[fileCheck.reason]];
      }
      if (input.idFile && input.idFile.length > 0) {
        const idCheck = detectCedulaFileType(input.idFile);
        if (!idCheck.ok) fields.idFile = [ID_FILE_MESSAGES[idCheck.reason]];
      }
      if (Object.keys(fields).length > 0) throw new ValidationError(fields);

      const newFile =
        input.cedulaFile && input.cedulaFile.length > 0 ? await deps.cedulaStorage.save(input.cedulaFile) : null;
      let newId: { name: string; sha256: string } | null = null;
      if (input.idFile && input.idFile.length > 0) {
        try {
          newId = await deps.cedulaStorage.save(input.idFile);
        } catch (error) {
          if (newFile) await removeQuietly(newFile.name);
          throw error;
        }
      }
      const replaced: { oldFile: string | null; oldId: string | null } = { oldFile: null, oldId: null };
      try {
        await withTransaction(deps.db, async (connection) => {
          const doctor = await findDoctorByUserId(connection, userId, true);
          if (!doctor) throw new NotFoundError();
          if (doctor.approvalStatus !== "rejected") {
            throw new AppError(409, "invalid_state", "Solo se puede reenviar una solicitud rechazada.");
          }

          const merged = {
            cedulaNumber: cedula ?? doctor.cedulaNumber,
            cedulaNormalized: cedula ?? doctor.cedulaNormalized,
            filePath: newFile?.name ?? doctor.cedulaFilePath,
            idPath: newId?.name ?? doctor.idFilePath,
            mobile: mobile ?? doctor.emergencyMobile,
          };
          const missing: Record<string, string[]> = {};
          if (merged.cedulaNormalized === null) missing.cedulaNumber = [required];
          if (merged.filePath === null) missing.cedulaFile = ["Adjunta la foto o el PDF de tu cédula."];
          if (merged.idPath === null) missing.idFile = [ID_FILE_MESSAGES.empty];
          if (merged.mobile === null) missing.emergencyMobile = [required];
          if (Object.keys(missing).length > 0) throw new ValidationError(missing);

          await connection.execute(
            `UPDATE doctor SET cedula_number = ?, cedula_normalized = ?, cedula_file_path = ?,
                    cedula_file_sha256 = COALESCE(?, cedula_file_sha256), id_file_path = ?,
                    id_file_sha256 = COALESCE(?, id_file_sha256), emergency_mobile = ?,
                    approval_status = 'pending', rejection_reason = NULL
              WHERE id = ?`,
            [
              merged.cedulaNumber,
              merged.cedulaNormalized,
              merged.filePath,
              newFile?.sha256 ?? null,
              merged.idPath,
              newId?.sha256 ?? null,
              merged.mobile,
              doctor.id,
            ],
          );
          replaced.oldFile = newFile && doctor.cedulaFilePath !== newFile.name ? doctor.cedulaFilePath : null;
          replaced.oldId = newId && doctor.idFilePath !== newId.name ? doctor.idFilePath : null;
          await enqueueEmail(
            connection,
            { template: "support_new_doctor", to: deps.supportEmail, payload: { doctorId: doctor.id } },
            clock,
          );
        });
      } catch (error) {
        if (newFile) await removeQuietly(newFile.name);
        if (newId) await removeQuietly(newId.name);
        return rethrowDuplicate(error);
      }
      if (replaced.oldFile) await removeQuietly(replaced.oldFile);
      if (replaced.oldId) await removeQuietly(replaced.oldId);
    },
  };
}
