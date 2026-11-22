import { readFileSync } from "node:fs";

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 128;

export type PasswordCheck =
  | { ok: true }
  | {
      ok: false;
      reason: "too_short" | "too_long" | "too_common" | "matches_identity";
      message: string;
    };

export interface PasswordContext {
  email?: string;
  name?: string;
}

let commonPasswords: ReadonlySet<string> | undefined;

function loadCommonPasswords(): ReadonlySet<string> {
  if (commonPasswords) return commonPasswords;
  const file = readFileSync(new URL("./data/common-passwords.txt", import.meta.url), "utf8");
  commonPasswords = new Set(
    file
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line.length > 0 && !line.startsWith("#")),
  );
  return commonPasswords;
}

function normalizeIdentity(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Política de contraseñas: mínimo 10 caracteres, sin reglas de composición, rechazo de comunes
 * y de las que coinciden con el correo o el nombre. Los mensajes nunca incluyen la contraseña.
 */
export function validatePassword(password: string, context: PasswordContext = {}): PasswordCheck {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      reason: "too_short",
      message: `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`,
    };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return {
      ok: false,
      reason: "too_long",
      message: `La contraseña no puede tener más de ${MAX_PASSWORD_LENGTH} caracteres.`,
    };
  }

  const normalized = normalizeIdentity(password);
  if (loadCommonPasswords().has(normalized)) {
    return {
      ok: false,
      reason: "too_common",
      message: "Esa contraseña es demasiado común. Elige una frase más larga y difícil de adivinar.",
    };
  }

  const identities = [context.email, context.name]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map(normalizeIdentity);
  if (identities.some((identity) => identity === normalized)) {
    return {
      ok: false,
      reason: "matches_identity",
      message: "La contraseña no puede ser igual a tu correo o a tu nombre.",
    };
  }

  return { ok: true };
}
