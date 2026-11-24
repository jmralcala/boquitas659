/** Nombre del enlace del micrositio (`/c/<nombre>`): 3 a 40 caracteres, minúsculas sin acentos, números y guiones. */
export const SLUG_MIN = 3;
export const SLUG_MAX = 40;

/** Sin guiones al principio, al final ni consecutivos. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidSlug(value: string): boolean {
  return value.length >= SLUG_MIN && value.length <= SLUG_MAX && SLUG_PATTERN.test(value);
}

/** Mensajes en español de lo que incumple un nombre; vacío si es válido. Nunca repite el valor recibido. */
export function slugErrors(value: string): string[] {
  if (isValidSlug(value)) return [];
  const errors: string[] = [];
  if (value.length < SLUG_MIN || value.length > SLUG_MAX) errors.push(`El nombre debe tener entre ${SLUG_MIN} y ${SLUG_MAX} caracteres.`);
  if (/^-|-$|--/.test(value)) errors.push("El nombre no puede empezar ni terminar con un guion ni tener dos guiones seguidos.");
  if (/[^a-z0-9-]/.test(value)) errors.push("Usa solo minúsculas sin acentos, números y guiones (sin espacios ni símbolos).");
  if (errors.length === 0) errors.push("El nombre no es válido: usa minúsculas, números y guiones.");
  return errors;
}
