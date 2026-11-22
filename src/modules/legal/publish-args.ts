import { parseArgs } from "node:util";
import { LEGAL_TYPES, isLegalType, type LegalType } from "./legal-service.js";

export interface PublishArgs {
  type: LegalType;
  file: string;
  title: string | undefined;
  /** Sin `--reviewed` el documento queda marcado como provisional (y bloquea altas en producción). */
  isProvisional: boolean;
}

/** Argumentos de `npm run legal:publish`. Lanza un `Error` con un mensaje claro ante cualquier uso incorrecto. */
export function parsePublishArgs(argv: readonly string[]): PublishArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      type: { type: "string" },
      file: { type: "string" },
      title: { type: "string" },
      reviewed: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (!values.type) throw new Error(`Falta --type. Valores válidos: ${LEGAL_TYPES.join(", ")}.`);
  if (!isLegalType(values.type)) throw new Error(`Tipo de documento inválido. Valores válidos: ${LEGAL_TYPES.join(", ")}.`);
  if (!values.file) throw new Error("Falta --file con la ruta del texto del documento.");

  return { type: values.type, file: values.file, title: values.title, isProvisional: !values.reviewed };
}
