import type { ResultSetHeader } from "mysql2/promise";
import type { Db } from "../../db/pool.js";
import { ValidationError } from "../../http/errors.js";
import { normalizeEmail } from "../../lib/normalize.js";
import type { PasswordHasher } from "../auth/password-hasher.js";
import { validatePassword } from "../auth/password-policy.js";

/**
 * Crea una cuenta de soporte. No existe registro público de soporte: solo se llama desde el script de línea
 * de comandos. La cuenta nace sin doble factor; el primer acceso obliga a configurarlo (US6).
 */
export async function createSupportUser(
  db: Db,
  hasher: PasswordHasher,
  input: { email: string; password: string },
): Promise<number> {
  const email = normalizeEmail(input.email);
  if (email === null) throw new ValidationError({ email: ["Escribe un correo válido."] });

  const check = validatePassword(input.password, { email: input.email });
  if (!check.ok) throw new ValidationError({ password: [check.message] });

  try {
    const [result] = await db.execute<ResultSetHeader>(
      "INSERT INTO `user` (email, email_normalized, role, password_hash, password_changed_at) VALUES (?, ?, 'support', ?, UTC_TIMESTAMP(3))",
      [email, email, await hasher.hash(input.password)],
    );
    return result.insertId;
  } catch (error) {
    if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
      throw new ValidationError({ email: ["Ya existe una cuenta con ese correo."] });
    }
    throw error;
  }
}
