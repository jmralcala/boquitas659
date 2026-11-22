import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export const MAX_CEDULA_BYTES = 5 * 1024 * 1024;

const NAME_PATTERN = /^[a-f0-9]{32}\.(jpg|png|pdf)$/;

export type CedulaFileCheck =
  | { ok: true; extension: "jpg" | "png" | "pdf"; mime: "image/jpeg" | "image/png" | "application/pdf" }
  | { ok: false; reason: "empty" | "size" | "type" };

/** Decide el tipo por la firma de bytes (no por la extensión ni el `Content-Type`, que el cliente controla). */
export function detectCedulaFileType(buffer: Buffer): CedulaFileCheck {
  if (buffer.length === 0) return { ok: false, reason: "empty" };
  if (buffer.length > MAX_CEDULA_BYTES) return { ok: false, reason: "size" };
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ok: true, extension: "jpg", mime: "image/jpeg" };
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ok: true, extension: "png", mime: "image/png" };
  }
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString("latin1") === "%PDF-") {
    return { ok: true, extension: "pdf", mime: "application/pdf" };
  }
  return { ok: false, reason: "type" };
}

export interface CedulaStorage {
  /** Guarda el archivo con un nombre aleatorio. Lanza si no es JPEG, PNG o PDF, o si pesa más de 5 MB. */
  save(buffer: Buffer): Promise<{ name: string; sha256: string }>;
  /** Lee un archivo guardado, o `null` si el nombre no es válido o no existe. */
  read(name: string): Promise<{ buffer: Buffer; mime: string } | null>;
  remove(name: string): Promise<void>;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  pdf: "application/pdf",
};

/**
 * Almacén de cédulas en un directorio privado (fuera de la raíz pública). Los nombres en disco son
 * aleatorios y nunca derivan de la entrada del usuario; cualquier nombre que no cumpla el patrón se
 * trata como inexistente, y además se comprueba que la ruta resuelta quede dentro del directorio.
 */
export function createCedulaStorage(directory: string): CedulaStorage {
  const root = resolve(directory);

  function pathFor(name: string): string | null {
    if (!NAME_PATTERN.test(name)) return null;
    const full = resolve(join(root, name));
    return full.startsWith(root + sep) ? full : null;
  }

  return {
    async save(buffer) {
      const check = detectCedulaFileType(buffer);
      if (!check.ok) throw new Error(`Archivo de cédula no válido (${check.reason}).`);
      await mkdir(root, { recursive: true });
      const name = `${randomBytes(16).toString("hex")}.${check.extension}`;
      const full = pathFor(name);
      if (full === null) throw new Error("Nombre de archivo inválido.");
      await writeFile(full, buffer, { flag: "wx", mode: 0o600 });
      return { name, sha256: createHash("sha256").update(buffer).digest("hex") };
    },

    async read(name) {
      const full = pathFor(name);
      if (full === null) return null;
      try {
        const buffer = await readFile(full);
        const extension = name.slice(name.lastIndexOf(".") + 1);
        return { buffer, mime: MIME_BY_EXTENSION[extension] ?? "application/octet-stream" };
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
