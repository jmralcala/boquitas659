import { LEGAL_TYPES, type LegalService, type LegalType } from "./legal-service.js";

export const DEFAULT_TITLES: Record<LegalType, string> = {
  patient_privacy: "Aviso de privacidad para pacientes",
  doctor_privacy: "Aviso de privacidad para médicos",
  reception_privacy: "Aviso de privacidad para personal de recepción",
  reception_confidentiality: "Compromiso de confidencialidad de recepción",
  terms_doctor: "Términos y condiciones del servicio para médicos",
};

const PROVISIONAL_NOTICE =
  "TEXTO PROVISIONAL. Este documento es un marcador de posición y no ha sido revisado por un abogado. " +
  "No debe usarse con pacientes reales ni con datos reales hasta sustituirse por la versión revisada.";

/**
 * Publica una versión 1 provisional de cada documento que aún no exista. Es idempotente.
 * En producción, mientras el documento siga marcado como provisional se bloquean las altas (FR-023).
 */
export async function seedProvisionalDocuments(legal: LegalService): Promise<void> {
  for (const type of LEGAL_TYPES) {
    if ((await legal.latest(type)) !== null) continue;
    await legal.publish({
      type,
      title: DEFAULT_TITLES[type],
      body: `${PROVISIONAL_NOTICE}\n\n${DEFAULT_TITLES[type]}.`,
      isProvisional: true,
    });
  }
}
