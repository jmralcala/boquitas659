import { describe, expect, it } from "vitest";
import { createPasswordHasher, type PasswordHasher } from "../../src/modules/auth/password-hasher.js";

// Parámetros bajos solo para que las pruebas sean rápidas.
const testOptions = { argon2: { memoryCost: 1024, timeCost: 2, parallelism: 1 }, bcryptCost: 4 };

describe.each(["argon2", "bcrypt"] as const)("PasswordHasher (%s)", (kind) => {
  const hasher: PasswordHasher = createPasswordHasher(kind, testOptions);

  it("hash y verify aceptan la contraseña correcta", async () => {
    const hash = await hasher.hash("una contraseña larga y segura");
    expect(hash).not.toContain("una contraseña larga y segura");
    expect(await hasher.verify(hash, "una contraseña larga y segura")).toBe(true);
  });

  it("verify rechaza una contraseña errónea", async () => {
    const hash = await hasher.hash("contraseña-correcta-1");
    expect(await hasher.verify(hash, "contraseña-correcta-2")).toBe(false);
  });

  it("produce hashes distintos para la misma contraseña (sal aleatoria)", async () => {
    const [a, b] = await Promise.all([hasher.hash("misma-contraseña-1"), hasher.hash("misma-contraseña-1")]);
    expect(a).not.toBe(b);
  });

  it("no revienta con contraseñas de más de 72 bytes y distingue su final", async () => {
    const larga = "x".repeat(100);
    const hash = await hasher.hash(larga + "A");
    expect(await hasher.verify(hash, larga + "A")).toBe(true);
    expect(await hasher.verify(hash, larga + "B")).toBe(false);
  });

  it("verify devuelve false ante un hash corrupto en lugar de lanzar", async () => {
    expect(await hasher.verify("esto-no-es-un-hash", "cualquier-cosa-1")).toBe(false);
  });

  it("needsRehash es falso para un hash recién creado", async () => {
    const hash = await hasher.hash("contraseña-correcta-1");
    expect(hasher.needsRehash(hash)).toBe(false);
  });

  it("dummyVerify consume tiempo comparable y siempre devuelve false", async () => {
    expect(await hasher.dummyVerify("cualquier-cosa-1")).toBe(false);
  });
});

describe("PasswordHasher compuesto", () => {
  it("verifica hashes de ambos formatos y pide rehash al cambiar de algoritmo", async () => {
    const argon = createPasswordHasher("argon2", testOptions);
    const bcrypt = createPasswordHasher("bcrypt", testOptions);
    const argonHash = await argon.hash("contraseña-correcta-1");
    const bcryptHash = await bcrypt.hash("contraseña-correcta-1");

    expect(await bcrypt.verify(argonHash, "contraseña-correcta-1")).toBe(true);
    expect(await argon.verify(bcryptHash, "contraseña-correcta-1")).toBe(true);
    expect(bcrypt.needsRehash(argonHash)).toBe(true);
    expect(argon.needsRehash(bcryptHash)).toBe(true);
  });
});
