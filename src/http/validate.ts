import type { z } from "zod";
import { ValidationError } from "./errors.js";

/**
 * Valida entrada externa (body, query, params) con un esquema zod.
 * Lanza `ValidationError` con mensajes por campo; nunca devuelve los valores recibidos.
 */
export function parseInput<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;

  const fields: Record<string, string[]> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.map(String).join(".") || "_";
    (fields[key] ??= []).push(issue.message);
  }
  throw new ValidationError(fields);
}
