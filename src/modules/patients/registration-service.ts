import type { ResultSetHeader } from "mysql2/promise";
import { z } from "zod";
import type { Db } from "../../db/pool.js";
import { withTransaction } from "../../db/tx.js";
import { LegalReviewPendingError, ValidationError } from "../../http/errors.js";
import { parseInput } from "../../http/validate.js";
import { parseBirthDate, todayInZone } from "../../lib/age.js";
import { systemClock, type Clock } from "../../lib/clock.js";
import { normalizeEmail, normalizeMxPhone } from "../../lib/normalize.js";
import type { PasswordHasher } from "../auth/password-hasher.js";
import { validatePassword } from "../auth/password-policy.js";
import type { LegalService } from "../legal/legal-service.js";
import { insertAccount, insertPatient } from "./patient-repository.js";

/** Zona horaria del consultorio (por ahora única: Ciudad de México). */
export const OFFICE_TIME_ZONE = "America/Mexico_City";

export interface PatientRegistrationDeps {
  db: Db;
  hasher: PasswordHasher;
  legal: LegalService;
  clock?: Clock;
  /** En producción, mientras el aviso sea provisional no se admiten altas (FR-023). */
  blockProvisional?: boolean;
}

const required = "Este campo es obligatorio.";

const registrationSchema = z.object({
  fullName: z.string({ error: required }).trim().min(2, "Escribe tu nombre completo.").max(200, "El nombre es demasiado largo."),
  birthDate: z.string({ error: required }).trim().min(1, required),
  email: z.string({ error: required }).trim().min(1, required).max(254, "El correo es demasiado largo."),
  phone: z.string({ error: required }).trim().min(1, required),
  password: z.string({ error: required }).min(1, required).max(256),
  acceptPrivacy: z.literal("yes", {
    error: "Debes aceptar el aviso de privacidad y otorgar tu consentimiento expreso para poder continuar con el agendamiento.",
  }),
});

const EXISTING_ACCOUNT_MESSAGE = "Ya existe una cuenta con este correo. Si es tuya, inicia sesión.";

export interface PatientRegistration {
  register(raw: unknown): Promise<{ userId: number; accountId: number; patientId: number }>;
}

export function createPatientRegistration(deps: PatientRegistrationDeps): PatientRegistration {
  const clock = deps.clock ?? systemClock;

  return {
    async register(raw) {
      if (deps.blockProvisional && (await deps.legal.hasProvisional(["patient_privacy"]))) {
        throw new LegalReviewPendingError();
      }
      const input = parseInput(registrationSchema, raw ?? {});
      const fields: Record<string, string[]> = {};

      const email = normalizeEmail(input.email);
      if (email === null) fields.email = ["Escribe un correo válido."];

      const phone = normalizeMxPhone(input.phone);
      if (phone === null) fields.phone = ["Escribe un teléfono de 10 dígitos."];

      const birthDate = parseBirthDate(input.birthDate, todayInZone(clock.now(), OFFICE_TIME_ZONE));
      if (birthDate === null) fields.birthDate = ["Escribe una fecha de nacimiento válida."];

      const passwordCheck = validatePassword(input.password, { email: input.email, name: input.fullName });
      if (!passwordCheck.ok) fields.password = [passwordCheck.message];

      if (Object.keys(fields).length > 0 || email === null || phone === null || birthDate === null) {
        throw new ValidationError(fields);
      }

      const privacy = await deps.legal.latest("patient_privacy");
      if (!privacy) throw new Error("Falta el aviso de privacidad de pacientes.");

      const passwordHash = await deps.hasher.hash(input.password);
      try {
        return await withTransaction(deps.db, async (connection) => {
          const now = clock.now();
          const [user] = await connection.execute<ResultSetHeader>(
            "INSERT INTO `user` (email, email_normalized, role, password_hash, password_changed_at, created_at) VALUES (?, ?, 'patient', ?, ?, ?)",
            [email, email, passwordHash, now, now],
          );
          const accountId = await insertAccount(connection, { userId: user.insertId, phone });
          const patientId = await insertPatient(connection, {
            accountId,
            fullName: input.fullName,
            birthDate,
            email,
            phone,
            isMinorDependent: false,
          });
          await deps.legal.recordAcceptance({ userId: user.insertId, documentId: privacy.id }, connection);
          return { userId: user.insertId, accountId, patientId };
        });
      } catch (error) {
        // Mensaje que invita a iniciar sesión sin revelar el rol de la cuenta existente.
        if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
          throw new ValidationError({ email: [EXISTING_ACCOUNT_MESSAGE] });
        }
        throw error;
      }
    },
  };
}
