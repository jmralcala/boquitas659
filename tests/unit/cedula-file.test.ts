import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_CEDULA_BYTES,
  createCedulaStorage,
  detectCedulaFileType,
  type CedulaStorage,
} from "../../src/modules/doctors/cedula-storage.js";

const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 2)]);
const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64, 3)]);

describe("detectCedulaFileType", () => {
  it("acepta JPEG, PNG y PDF por su firma de bytes", () => {
    expect(detectCedulaFileType(jpeg)).toEqual({ ok: true, extension: "jpg", mime: "image/jpeg" });
    expect(detectCedulaFileType(png)).toEqual({ ok: true, extension: "png", mime: "image/png" });
    expect(detectCedulaFileType(pdf)).toEqual({ ok: true, extension: "pdf", mime: "application/pdf" });
  });

  it("rechaza otros tipos aunque el contenido parezca inofensivo", () => {
    expect(detectCedulaFileType(Buffer.from("<html><script>alert(1)</script></html>"))).toMatchObject({
      ok: false,
      reason: "type",
    });
    expect(detectCedulaFileType(Buffer.from("MZ\x90\x00 ejecutable"))).toMatchObject({ ok: false, reason: "type" });
    expect(detectCedulaFileType(Buffer.from("GIF89a"))).toMatchObject({ ok: false, reason: "type" });
    expect(detectCedulaFileType(Buffer.alloc(0))).toMatchObject({ ok: false, reason: "empty" });
  });

  it("rechaza archivos de más de 5 MB", () => {
    const grande = Buffer.concat([jpeg, Buffer.alloc(MAX_CEDULA_BYTES)]);
    expect(detectCedulaFileType(grande)).toMatchObject({ ok: false, reason: "size" });
    const limite = Buffer.concat([jpeg, Buffer.alloc(MAX_CEDULA_BYTES - jpeg.length)]);
    expect(detectCedulaFileType(limite)).toMatchObject({ ok: true });
  });
});

describe("createCedulaStorage", () => {
  let dir: string;
  let storage: CedulaStorage;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cedulas-"));
    storage = createCedulaStorage(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("guarda con nombre aleatorio, calcula el SHA-256 y no usa el nombre original", async () => {
    const saved = await storage.save(jpeg);
    expect(saved.name).toMatch(/^[a-f0-9]{32}\.jpg$/);
    expect(saved.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(readdirSync(dir)).toEqual([saved.name]);
    expect(readFileSync(join(dir, saved.name)).equals(jpeg)).toBe(true);

    const other = await storage.save(jpeg);
    expect(other.name).not.toBe(saved.name);
  });

  it("lee el archivo guardado con su tipo", async () => {
    const saved = await storage.save(pdf);
    const read = await storage.read(saved.name);
    expect(read?.mime).toBe("application/pdf");
    expect(read?.buffer.equals(pdf)).toBe(true);
  });

  it("rechaza guardar tipos no permitidos", async () => {
    await expect(storage.save(Buffer.from("hola"))).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("una ruta con .. o separadores nunca sale del directorio privado", async () => {
    await expect(storage.read("../../etc/passwd")).resolves.toBeNull();
    await expect(storage.read("..\\..\\windows\\win.ini")).resolves.toBeNull();
    await expect(storage.read("/etc/passwd")).resolves.toBeNull();
    await expect(storage.read("0123456789abcdef0123456789abcdef.jpg/../../x")).resolves.toBeNull();
    await expect(storage.read("0123456789abcdef0123456789abcdef.exe")).resolves.toBeNull();
  });

  it("devuelve null si el archivo no existe y permite borrarlo", async () => {
    expect(await storage.read("0123456789abcdef0123456789abcdef.jpg")).toBeNull();
    const saved = await storage.save(png);
    await storage.remove(saved.name);
    expect(await storage.read(saved.name)).toBeNull();
    await storage.remove("../../fuera.png"); // no hace nada ni lanza
  });
});
