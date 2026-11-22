import { afterEach, describe, expect, it, vi } from "vitest";
import { generateToken, hashToken } from "../../src/lib/tokens.js";

describe("tokens", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("genera 32 bytes aleatorios en base64url (43 caracteres)", () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("genera tokens distintos en cada llamada", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateToken()));
    expect(tokens.size).toBe(200);
  });

  it("no usa Math.random", () => {
    vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Math.random no debe usarse para tokens");
    });
    expect(() => generateToken()).not.toThrow();
  });

  it("calcula un SHA-256 hexadecimal estable", () => {
    expect(hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hashToken("abc")).toBe(hashToken("abc"));
    expect(hashToken("abc")).not.toBe(hashToken("abd"));
  });
});
