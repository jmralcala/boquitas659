import { z } from "zod";
import type { Db } from "../../db/pool.js";
import { withTransaction } from "../../db/tx.js";
import { ForbiddenError, ValidationError } from "../../http/errors.js";
import { parseInput } from "../../http/validate.js";
import { parseBirthDate, todayInZone } from "../../lib/age.js";
import { systemClock, type Clock } from "../../lib/clock.js";
import { normalizeMxPhone } from "../../lib/normalize.js";
import type { LegalService } from "../legal/legal-service.js";
import { findAccountByUserId, insertPatient } from "./patient-repository.js";
import { OFFICE_TIME_ZONE } from "./registration-service.js";

export interface DependentsDeps {
  db: Db;
  legal: LegalService;
  clock?: Clock;
}

const required = "Este campo es obligatorio.";

const dependentSchema = z.object({
  fullName: z.string({ error: required }).trim().min(2, "Escribe el nombre completo.").max(200, "El nombre es demasiado largo."),
  birthDate: z.string({ error: required }).trim().min(1, required),
  phone: z.string().trim().optional(),
  acceptPrivacyOnBehalf: z.literal("yes", {
    error: "Debes aceptar el aviso de privacidad en nombre del menor para continuar.",
  }),
});

export interface DependentsService {
  /**
   * Añade un paciente adicional (por ejemplo un hijo) bajo la cuenta de quien tiene la sesión. Siempre usa la
   * cuenta de `userId`: no existe forma de indicar otra cuenta.
   */
  addDependent(userId: number, raw: unknown): Promise<{ patientId: number }>;
}

export function createDependentsService(deps: DependentsDeps): DependentsService {
  const clock = deps.clock ?? systemClock;

  return {
    async addDependent(userId, raw) {
      const input = parseInput(dependentSchema, raw ?? {});
      const fields: Record<string, string[]> = {};

      const birthDate = parseBirthDate(input.birthDate, todayInZone(clock.now(), OFFICE_TIME_ZONE));
      if (birthDate === null) fields.birthDate = ["Escribe una fecha de nacimiento válida."];

      let phone: string | null = null;
      if (input.phone) {
        phone = normalizeMxPhone(input.phone);
        if (phone === null) fields.phone = ["Escribe un teléfono de 10 dígitos."];
      }
      if (Object.keys(fields).length > 0 || birthDate === null) throw new ValidationError(fields);

      const account = await findAccountByUserId(deps.db, userId);
      if (!account) throw new ForbiddenError();
      const privacy = await deps.legal.latest("patient_privacy");
      if (!privacy) throw new Error("Falta el aviso de privacidad de pacientes.");

      return withTransaction(deps.db, async (connection) => {
        const patientId = await insertPatient(connection, {
          accountId: account.id,
          fullName: input.fullName,
          birthDate,
          email: null,
          phone,
          isMinorDependent: true,
        });
        // El tutor consiente en nombre del menor: la aceptación queda ligada al paciente adicional.
        await deps.legal.recordAcceptance(
          { userId, documentId: privacy.id, onBehalfOfPatientId: patientId },
          connection,
        );
        return { patientId };
      });
    },
  };
}
