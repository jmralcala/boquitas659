import { z } from "zod";

/**
 * Contenido del triaje de urgencias. TEXTO PROVISIONAL: lo valida un dentista antes de mostrarse a pacientes reales
 * (constitución, restricciones de producto). Mientras `reviewedByDentist` sea `false`, en producción el flujo de urgencia no
 * se ofrece y se dirige a llamar al consultorio. El valor solo cambia a `true` tras la validación, junto con una nueva
 * `version`, por commit y revisión.
 *
 * Nada de lo que el paciente elige aquí se guarda (principio I): la categoría solo se usa para escoger la ventana de tiempo
 * y para el aviso efímero al médico en la cola de envío.
 */

/** Orden de gravedad: del más urgente al menos urgente. */
export const CATEGORY_IDS = ["rojo", "naranja", "amarillo", "verde_claro", "verde"] as const;
export type CategoryId = (typeof CATEGORY_IDS)[number];

export const ALARM_SIGNAL_IDS = ["dificultad_respirar_tragar", "hinchazon_ojo"] as const;
export type AlarmSignalId = (typeof ALARM_SIGNAL_IDS)[number];

export interface TriageCategory {
  id: CategoryId;
  /** Nombre del semáforo (es lo que lee el médico en su aviso). */
  label: string;
  /** Tono del semáforo (1 a 5, de rojo a verde): elige el color de la hoja de estilos; solo para la pantalla. */
  tone: 1 | 2 | 3 | 4 | 5;
  /** Texto de la opción que ve el paciente. */
  optionText: string;
  /** Tiempo máximo que puede esperar este nivel para que se le asigne un espacio. */
  windowHours: number;
  /** Si, al no haber espacio, se muestra además el aviso de acudir a un hospital. */
  requiresHospitalNotice: boolean;
}

export interface AlarmSignal {
  id: AlarmSignalId;
  label: string;
}

export interface TriageContent {
  version: string;
  reviewedByDentist: boolean;
  categories: readonly TriageCategory[];
  alarmSignals: readonly AlarmSignal[];
  /** Aviso de deslinde de responsabilidad que se muestra en el formulario de urgencia. */
  disclaimer: { title: string; text: string };
  /** Encabezado, introducción y condiciones del aviso de emergencia hospitalaria. */
  emergencyHeading: string;
  emergencyIntro: string;
  emergencyConditions: readonly string[];
  /** Indicaciones provisionales mientras llega la cita. */
  firstAidHeading: string;
  firstAid: readonly { label: string; text: string }[];
  /** Instrucción final cuando no hay espacio en un nivel alto (se muestra tras las condiciones de emergencia). */
  hospitalNotice: string;
  /** Instrucción final cuando el paciente marca una señal de alarma (se muestra tras las condiciones de emergencia). */
  alarmNotice: string;
}

export const TRIAGE_CONTENT: TriageContent = {
  version: "2026-11-26-provisional-2",
  reviewedByDentist: false,
  categories: [
    {
      id: "rojo",
      label: "Rojo",
      tone: 1,
      optionText: "Sangrado que no se detiene, golpe fuerte en la cara o la boca, o un diente caído por un golpe.",
      windowHours: 2,
      requiresHospitalNotice: true,
    },
    {
      id: "naranja",
      label: "Naranja",
      tone: 2,
      optionText: "Dolor muy intenso que no cede con analgésicos, o una inflamación o absceso.",
      windowHours: 12,
      requiresHospitalNotice: true,
    },
    {
      id: "amarillo",
      label: "Amarillo",
      tone: 3,
      optionText: "Diente o muela rota con dolor, o un empaste o corona que se salió con dolor.",
      windowHours: 24,
      requiresHospitalNotice: false,
    },
    {
      id: "verde_claro",
      label: "Verde claro",
      tone: 4,
      optionText: "Dolor moderado o sensibilidad fuerte que molesta al comer o al dormir.",
      windowHours: 48,
      requiresHospitalNotice: false,
    },
    {
      id: "verde",
      label: "Verde",
      tone: 5,
      optionText: "Molestia leve, aparato que lastima o una pieza floja sin dolor intenso.",
      windowHours: 72,
      requiresHospitalNotice: false,
    },
  ],
  alarmSignals: [
    { id: "dificultad_respirar_tragar", label: "Tengo dificultad para tragar o para respirar" },
    { id: "hinchazon_ojo", label: "Tengo hinchazón cerca del ojo" },
  ],
  disclaimer: {
    title: "Aviso de deslinde de responsabilidad médica y asistencial:",
    text:
      "Este asistente de agenda de urgencias es una herramienta tecnológica orientativa para la asignación y priorización de horarios de consulta presencial. " +
      "En ningún caso constituye un diagnóstico clínico, triaje médico definitivo ni sustituto del examen directo por parte de un profesional de la salud dental. " +
      "Si experimenta dolor incontrolable o malestar severo, acuda de inmediato a un centro de salud.",
  },
  emergencyHeading: "ATENCIÓN - RIESGO DE EMERGENCIA MÉDICA:",
  emergencyIntro: "Si usted o el paciente presenta alguna de las siguientes condiciones:",
  emergencyConditions: [
    "Sangrado continuo o abundante que no se detiene tras aplicar presión directa.",
    "Inflamación de rápido avance que compromete el ojo, el cuello o el piso de la boca.",
    "Dificultad para respirar, hablar o deglutir (tragar).",
    "Traumatismo con pérdida de consciencia o desorientación.",
  ],
  firstAidHeading: "Recomendaciones de cuidado mientras acude a su consulta:",
  firstAid: [
    {
      label: "Diente expulsado por golpe (avulsión dental)",
      text: "Sujete la pieza dental únicamente por la corona blanca; evite frotar o limpiar la raíz. Consérvela de inmediato sumergida en leche pasteurizada o solución salina estéril y llévela consigo al consultorio.",
    },
    {
      label: "Control de hemorragia",
      text: "Coloque una gasa limpia y seca sobre la zona afectada y muerda o presione firmemente de forma continua durante al menos 10 a 15 minutos.",
    },
    {
      label: "Manejo del dolor e inflamación",
      text: "Aplique compresas frías sobre la mejilla en el área afectada. No aplique fuentes de calor ni coloque tabletas de analgésicos directamente sobre la encía o la mucosa bucal.",
    },
  ],
  hospitalNotice:
    "No espere una cita dental. Diríjase de inmediato al servicio de urgencias hospitalarias más cercano o comuníquese a la línea de emergencias médicas de su localidad (911).",
  alarmNotice:
    "No espere una cita dental. Diríjase de inmediato al servicio de urgencias hospitalarias más cercano o comuníquese a la línea de emergencias médicas de su localidad (911).",
};

export const categorySchema = z.enum(CATEGORY_IDS, { error: "Elige una de las opciones." });

const alarmListSchema = z.array(z.enum(ALARM_SIGNAL_IDS));

/** Categoría válida o `null`. Nunca devuelve ni registra el valor recibido. */
export function parseCategory(value: unknown): CategoryId | null {
  const parsed = categorySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Señales de alarma marcadas: `[]` si no hay ninguna (ausente o vacío), la lista sin repetidos si todas son válidas, o
 * `null` si llega cualquier valor desconocido.
 */
export function parseAlarmSignals(value: unknown): AlarmSignalId[] | null {
  if (value === undefined || value === "") return [];
  const list = Array.isArray(value) ? value : [value];
  const parsed = alarmListSchema.safeParse(list);
  return parsed.success ? [...new Set(parsed.data)] : null;
}

export function categoryById(id: CategoryId, content: TriageContent = TRIAGE_CONTENT): TriageCategory {
  const found = content.categories.find((category) => category.id === id);
  if (!found) throw new Error("Categoría de triaje desconocida.");
  return found;
}

/** En producción el flujo solo se ofrece cuando un dentista validó el contenido; en desarrollo y pruebas siempre. */
export function urgentContentAvailable(appEnv: "development" | "production", content: TriageContent = TRIAGE_CONTENT): boolean {
  return appEnv !== "production" || content.reviewedByDentist;
}
