import { generate, generateSecret } from "otplib";
import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
  verifyTotpCode,
} from "../../src/modules/auth/totp.js";

const KEY = "ab".repeat(32);
const OTHER_KEY = "cd".repeat(32);

describe("cifrado del secreto TOTP (AES-256-GCM)", () => {
  it("recupera el secreto original y nunca lo deja en claro", () => {
    const secret = generateSecret();
    const encrypted = encryptSecret(secret, KEY);
    expect(encrypted).not.toContain(secret);
    expect(encrypted.startsWith("v1:")).toBe(true);
    expect(decryptSecret(encrypted, KEY)).toBe(secret);
  });

  it("usa un vector de inicialización distinto cada vez", () => {
    const secret = generateSecret();
    expect(encryptSecret(secret, KEY)).not.toBe(encryptSecret(secret, KEY));
  });

  it("detecta manipulación y claves equivocadas", () => {
    const encrypted = encryptSecret(generateSecret(), KEY);
    expect(() => decryptSecret(encrypted, OTHER_KEY)).toThrow();
    const tampered = `${encrypted.slice(0, -2)}${encrypted.endsWith("AA") ? "BB" : "AA"}`;
    expect(() => decryptSecret(tampered, KEY)).toThrow();
    expect(() => decryptSecret("v1:no-es-valido", KEY)).toThrow();
    expect(() => decryptSecret("sin-version", KEY)).toThrow();
  });

  it("rechaza una clave que no mida 32 bytes", () => {
    expect(() => encryptSecret("SECRETO", "abcd")).toThrow();
  });
});

describe("verifyTotpCode", () => {
  const secret = generateSecret();
  const now = new Date("2026-06-01T10:00:10.000Z").getTime();

  it("acepta el código del paso actual y devuelve su paso de tiempo", async () => {
    const token = await generate({ secret, epoch: now / 1000 });
    const result = await verifyTotpCode({ secret, token, nowMs: now });
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.timeStep).toBe(Math.floor(now / 1000 / 30));
  });

  it("tolera un paso de diferencia (30 s) pero no más", async () => {
    const past = await generate({ secret, epoch: now / 1000 - 30 });
    expect((await verifyTotpCode({ secret, token: past, nowMs: now })).valid).toBe(true);
    const future = await generate({ secret, epoch: now / 1000 + 30 });
    expect((await verifyTotpCode({ secret, token: future, nowMs: now })).valid).toBe(true);
    const old = await generate({ secret, epoch: now / 1000 - 90 });
    expect((await verifyTotpCode({ secret, token: old, nowMs: now })).valid).toBe(false);
  });

  it("rechaza la reutilización: un código de un paso ya usado no vuelve a servir", async () => {
    const token = await generate({ secret, epoch: now / 1000 });
    const first = await verifyTotpCode({ secret, token, nowMs: now });
    expect(first.valid).toBe(true);
    const lastStep = first.valid ? first.timeStep : 0;
    expect((await verifyTotpCode({ secret, token, nowMs: now, afterTimeStep: lastStep })).valid).toBe(false);
  });

  it("rechaza códigos con formato inválido sin lanzar", async () => {
    for (const token of ["", "abc", "12345", "1234567", "12 34 56x"]) {
      expect((await verifyTotpCode({ secret, token, nowMs: now })).valid, token).toBe(false);
    }
  });

  it("un código de otro secreto no sirve", async () => {
    const token = await generate({ secret: generateSecret(), epoch: now / 1000 });
    expect((await verifyTotpCode({ secret, token, nowMs: now })).valid).toBe(false);
  });
});

describe("códigos de recuperación", () => {
  it("genera 10 códigos únicos y difíciles de adivinar con formato legible", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}$/);
  });

  it("el hash normaliza mayúsculas, espacios y guiones y depende de la clave", () => {
    const code = "abcde-fghjk";
    expect(normalizeRecoveryCode(" ABCDE fghjk ")).toBe("abcdefghjk");
    expect(hashRecoveryCode("ABCDE-FGHJK", KEY)).toBe(hashRecoveryCode(code, KEY));
    expect(hashRecoveryCode(code, KEY)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRecoveryCode(code, KEY)).not.toBe(hashRecoveryCode(code, OTHER_KEY));
    expect(hashRecoveryCode(code, KEY)).not.toContain("abcde");
  });
});
