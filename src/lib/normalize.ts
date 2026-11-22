import { z } from "zod";

const emailSchema = z.email();

/** Correo normalizado (minúsculas, sin espacios) o `null` si el formato es inválido. */
export function normalizeEmail(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (value.length === 0 || value.length > 254) return null;
  const result = emailSchema.safeParse(value);
  return result.success ? value : null;
}

/**
 * Teléfono mexicano de 10 dígitos o `null`. Acepta separadores y los prefijos +52, 0052 y el formato
 * antiguo +521. Desde 2019 los móviles y fijos mexicanos tienen el mismo formato, así que no se puede
 * saber por el número si es móvil.
 */
export function normalizeMxPhone(raw: string): string | null {
  let value = raw.replace(/[\s().-]/g, "");
  if (value.startsWith("+")) value = value.slice(1);
  else if (value.startsWith("00")) value = value.slice(2);
  if (!/^\d+$/.test(value)) return null;
  if (value.startsWith("521") && value.length === 13) value = value.slice(3);
  else if (value.startsWith("52") && value.length === 12) value = value.slice(2);
  if (value.length !== 10) return null;
  if (value.startsWith("0") || value.startsWith("1")) return null;
  return value;
}

/** Cédula profesional: solo dígitos, 7 u 8 caracteres, o `null`. */
export function normalizeCedula(raw: string): string | null {
  const value = raw.replace(/[\s-]/g, "");
  return /^\d{7,8}$/.test(value) ? value : null;
}
