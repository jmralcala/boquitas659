import { createHmac, timingSafeEqual } from "node:crypto";

/** Una hora de apertura firmada vale 60 minutos: pasado ese plazo se descarta (no entra en el tiempo para reservar). */
export const OPENED_AT_MAX_AGE_MS = 60 * 60 * 1000;

const LABEL = "booking-opened-at:v1";

function mac(secret: string, millis: string): string {
  return createHmac("sha256", secret).update(`${LABEL}:${millis}`).digest("hex");
}

/**
 * Hora en que el paciente entró a la pantalla de reservar, firmada con un secreto de la sesión. Viaja en un enlace y en
 * un campo oculto; sirve solo para medir cuánto tardó en reservar. No identifica a nadie y no autoriza nada.
 */
export function signOpenedAt(secret: string, at: Date): string {
  const millis = String(at.getTime());
  return `${millis}.${mac(secret, millis)}`;
}

/** Hora de apertura si la firma es válida, no es del futuro y no pasó de 60 minutos; si no, `null`. */
export function verifyOpenedAt(secret: string, token: unknown, now: Date): Date | null {
  if (typeof token !== "string" || token.length > 80) return null;
  const [millis, signature, extra] = token.split(".");
  if (!millis || !signature || extra !== undefined || !/^\d{10,15}$/.test(millis)) return null;
  const expected = Buffer.from(mac(secret, millis), "hex");
  const given = Buffer.from(signature, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const age = now.getTime() - Number(millis);
  if (age < 0 || age > OPENED_AT_MAX_AGE_MS) return null;
  return new Date(Number(millis));
}
