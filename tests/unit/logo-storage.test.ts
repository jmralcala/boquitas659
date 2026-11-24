import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_LOGO_BYTES, createLogoStorage, detectLogoType, type LogoStorage } from "../../src/modules/site/logo-storage.js";

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 2)]);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x40, 0, 0, 0]), Buffer.from("WEBP"), Buffer.alloc(64, 3)]);

describe("detectLogoType", () => {
  it("acepta PNG, JPEG y WebP por su firma de bytes", () => {
    expect(detectLogoType(png)).toEqual({ ok: true, extension: "png", mime: "image/png" });
    expect(detectLogoType(jpeg)).toEqual({ ok: true, extension: "jpg", mime: "image/jpeg" });
    expect(detectLogoType(webp)).toEqual({ ok: true, extension: "webp", mime: "image/webp" });
  });

  it("rechaza SVG, GIF, PDF, HTML, ejecutables y un RIFF que no es WebP", () => {
    for (const content of [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      "GIF89a\x01\x00",
      "%PDF-1.7\n",
      "<html><script>alert(1)</script></html>",
      "MZ\x90\x00 ejecutable",
      "RIFF\x40\x00\x00\x00WAVEfmt ",
    ]) {
      expect(detectLogoType(Buffer.from(content, "latin1")), content.slice(0, 12)).toMatchObject({ ok: false, reason: "type" });
    }
  });

  it("rechaza un archivo vacío", () => {
    expect(detectLogoType(Buffer.alloc(0))).toMatchObject({ ok: false, reason: "empty" });
  });

  it("el máximo es 1 MB (1 048 576 bytes): justo en el límite se acepta, un byte más no", () => {
    expect(MAX_LOGO_BYTES).toBe(1_048_576);
    const limit = Buffer.concat([png, Buffer.alloc(MAX_LOGO_BYTES - png.length)]);
    expect(limit.length).toBe(MAX_LOGO_BYTES);
    expect(detectLogoType(limit)).toMatchObject({ ok: true });
    expect(detectLogoType(Buffer.concat([limit, Buffer.alloc(1)]))).toMatchObject({ ok: false, reason: "size" });
  });

  it("decide por el contenido: un texto que se llame .png se rechaza", () => {
    expect(detectLogoType(Buffer.from("esto no es una imagen .png"))).toMatchObject({ ok: false, reason: "type" });
  });
});

describe("createLogoStorage", () => {
  let directory: string;
  let storage: LogoStorage;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "boquitas-logos-"));
    storage = createLogoStorage(directory);
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("guarda con un nombre aleatorio `<32 hex>.<ext>` y lo devuelve con su tipo", async () => {
    const saved = await storage.save(png);
    expect(saved.name).toMatch(/^[a-f0-9]{32}\.png$/);
    expect(readdirSync(directory)).toEqual([saved.name]);
    expect(await storage.read(saved.name)).toEqual({ buffer: png, mime: "image/png" });
    expect((await storage.save(webp)).name).toMatch(/\.webp$/);
    expect((await storage.save(jpeg)).name).toMatch(/\.jpg$/);
  });

  it("dos guardados del mismo archivo producen nombres distintos", async () => {
    const a = await storage.save(png);
    const b = await storage.save(png);
    expect(a.name).not.toBe(b.name);
  });

  it("no guarda nada si el archivo no es válido (lanza)", async () => {
    await expect(storage.save(Buffer.from("<svg></svg>"))).rejects.toThrow();
    await expect(storage.save(Buffer.alloc(MAX_LOGO_BYTES + 1, 0xff))).rejects.toThrow();
    expect(readdirSync(directory)).toEqual([]);
  });

  it("read rechaza nombres que no cumplen el patrón o que salen del directorio", async () => {
    for (const name of ["../secreto.png", "..\\secreto.png", "a/b.png", "abc.png", `${"x".repeat(32)}.png`, `${"a".repeat(32)}.svg`, `${"a".repeat(32)}.png/`, ""]) {
      expect(await storage.read(name), name).toBeNull();
    }
  });

  it("read de un nombre válido que no existe devuelve null", async () => {
    expect(await storage.read(`${"a".repeat(32)}.png`)).toBeNull();
  });

  it("remove borra el archivo, ignora nombres inválidos y es idempotente", async () => {
    const saved = await storage.save(png);
    await storage.remove(saved.name);
    expect(readdirSync(directory)).toEqual([]);
    await storage.remove(saved.name);
    await storage.remove("../fuera.png");
  });

  it("crea el directorio si no existe", async () => {
    const nested = join(directory, "a", "b");
    const saved = await createLogoStorage(nested).save(png);
    expect(statSync(join(nested, saved.name)).isFile()).toBe(true);
  });
});
