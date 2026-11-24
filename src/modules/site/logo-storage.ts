import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

/** Tamaño máximo del logo: 1 MB. */
export const MAX_LOGO_BYTES = 1_048_576;

const NAME_PATTERN = /^[a-f0-9]{32}\.(png|jpg|webp)$/;

export type LogoFileCheck =
  | { ok: true; extension: "png" | "jpg" | "webp"; mime: "image/png" | "image/jpeg" | "image/webp" }
  | { ok: false; reason: "empty" | "size" | "type" };

const MIME_BY_EXTENSION: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

/**
 * Decide el tipo por la firma de bytes (no por la extensión ni el `Content-Type`, que el cliente controla). Solo PNG,
 * JPEG y WebP: SVG queda fuera porque puede llevar scripts. Que una imagen válida lleve contenido extra no se puede
 * detectar por la firma, por eso el logo se sirve siempre con un tipo fijo, `nosniff` y sin ejecutarse nunca.
 */
export function detectLogoType(buffer: Buffer): LogoFileCheck {
  if (buffer.length === 0) return { ok: false, reason: "empty" };
  if (buffer.length > MAX_LOGO_BYTES) return { ok: false, reason: "size" };
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ok: true, extension: "png", mime: "image/png" };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ok: true, extension: "jpg", mime: "image/jpeg" };
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP") {
    return { ok: true, extension: "webp", mime: "image/webp" };
  }
  return { ok: false, reason: "type" };
}

export interface LogoStorage {
  /** Guarda el logo con un nombre aleatorio. Lanza si no es PNG, JPEG o WebP, o si pesa más de 1 MB. */
  save(buffer: Buffer): Promise<{ name: string }>;
  /** Lee un logo guardado, o `null` si el nombre no es válido o no existe. */
  read(name: string): Promise<{ buffer: Buffer; mime: string } | null>;
  remove(name: string): Promise<void>;
}

/**
 * Almacén de logos en un directorio privado (fuera de la raíz pública). Los nombres en disco son aleatorios y nunca
 * derivan de la entrada del usuario; cualquier nombre que no cumpla el patrón se trata como inexistente, y además se
 * comprueba que la ruta resuelta quede dentro del directorio (mismo patrón que el almacén de cédulas).
 */
export function createLogoStorage(directory: string): LogoStorage {
  const root = resolve(directory);

  function pathFor(name: string): string | null {
    if (!NAME_PATTERN.test(name)) return null;
    const full = resolve(join(root, name));
    return full.startsWith(root + sep) ? full : null;
  }

  return {
    async save(buffer) {
      const check = detectLogoType(buffer);
      if (!check.ok) throw new Error(`Logo no válido (${check.reason}).`);
      await mkdir(root, { recursive: true });
      const name = `${randomBytes(16).toString("hex")}.${check.extension}`;
      const full = pathFor(name);
      if (full === null) throw new Error("Nombre de archivo inválido.");
      await writeFile(full, buffer, { flag: "wx", mode: 0o600 });
      return { name };
    },

    async read(name) {
      const full = pathFor(name);
      if (full === null) return null;
      try {
        const buffer = await readFile(full);
        return { buffer, mime: MIME_BY_EXTENSION[name.slice(name.lastIndexOf(".") + 1)] ?? "application/octet-stream" };
      } catch {
        return null;
      }
    },

    async remove(name) {
      const full = pathFor(name);
      if (full === null) return;
      await rm(full, { force: true });
    },
  };
}
