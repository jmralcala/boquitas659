import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  /** Devuelve `false` (nunca lanza) ante contraseña errónea o hash corrupto. */
  verify(hash: string, password: string): Promise<boolean>;
  /** Verdadero si el hash usa otro algoritmo o parámetros más débiles que la configuración actual. */
  needsRehash(hash: string): boolean;
  /** Gasta un tiempo comparable a `verify` sin cuenta real, para no revelar si un correo existe. */
  dummyVerify(password: string): Promise<boolean>;
}

export interface Argon2Options {
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

export interface PasswordHasherOptions {
  argon2: Argon2Options;
  bcryptCost: number;
}

// Valores por defecto orientados a ~250-500 ms en un servidor modesto; se calibran en el despliegue.
const defaultOptions: PasswordHasherOptions = {
  argon2: { memoryCost: 19456, timeCost: 2, parallelism: 1 },
  bcryptCost: 12,
};

type Argon2Module = typeof import("argon2");

// El módulo nativo se importa de forma diferida para que el respaldo bcrypt funcione
// aunque `argon2` no se pueda cargar en el hosting.
let argon2Promise: Promise<Argon2Module> | undefined;
function loadArgon2(): Promise<Argon2Module> {
  argon2Promise ??= import("argon2");
  return argon2Promise;
}

/** bcrypt solo mira los primeros 72 bytes; se pre-hashea para no truncar contraseñas largas. */
function bcryptInput(password: string): string {
  return createHash("sha256").update(password, "utf8").digest("base64");
}

function isArgon2Hash(hash: string): boolean {
  return hash.startsWith("$argon2id$");
}

function isBcryptHash(hash: string): boolean {
  return /^\$2[abxy]\$\d{2}\$/.test(hash);
}

function bcryptCostOf(hash: string): number {
  return Number(hash.slice(4, 6));
}

function argon2ParamsOf(hash: string): { m: number; t: number; p: number } | null {
  const match = /\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(hash);
  if (!match) return null;
  return { m: Number(match[1]), t: Number(match[2]), p: Number(match[3]) };
}

/**
 * Crea el hasher configurado (`argon2` o `bcrypt`). Siempre verifica hashes de ambos formatos,
 * de modo que cambiar de algoritmo no invalida las contraseñas existentes (se re-hashean al iniciar sesión).
 */
export function createPasswordHasher(
  kind: "argon2" | "bcrypt",
  options: Partial<PasswordHasherOptions> = {},
): PasswordHasher {
  const config: PasswordHasherOptions = {
    argon2: { ...defaultOptions.argon2, ...options.argon2 },
    bcryptCost: options.bcryptCost ?? defaultOptions.bcryptCost,
  };

  async function hash(password: string): Promise<string> {
    if (kind === "argon2") {
      const argon2 = await loadArgon2();
      return argon2.hash(password, { type: argon2.argon2id, ...config.argon2 });
    }
    return bcrypt.hash(bcryptInput(password), config.bcryptCost);
  }

  async function verify(stored: string, password: string): Promise<boolean> {
    try {
      if (isArgon2Hash(stored)) {
        const argon2 = await loadArgon2();
        return await argon2.verify(stored, password);
      }
      if (isBcryptHash(stored)) {
        return await bcrypt.compare(bcryptInput(password), stored);
      }
      return false;
    } catch {
      return false;
    }
  }

  function needsRehash(stored: string): boolean {
    if (kind === "argon2") {
      const params = argon2ParamsOf(stored);
      if (!isArgon2Hash(stored) || params === null) return true;
      return (
        params.m < config.argon2.memoryCost ||
        params.t < config.argon2.timeCost ||
        params.p !== config.argon2.parallelism
      );
    }
    return !isBcryptHash(stored) || bcryptCostOf(stored) < config.bcryptCost;
  }

  let dummyHash: Promise<string> | undefined;
  async function dummyVerify(password: string): Promise<boolean> {
    dummyHash ??= hash("contraseña-ficticia-no-usar-jamás");
    await verify(await dummyHash, password);
    return false;
  }

  return { hash, verify, needsRehash, dummyVerify };
}
