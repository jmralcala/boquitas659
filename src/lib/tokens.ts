import { createHash, randomBytes } from "node:crypto";

/** Token secreto de 32 bytes aleatorios en base64url. Nunca usa `Math.random`. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 hexadecimal. Apto para tokens de alta entropía (no para contraseñas). */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
