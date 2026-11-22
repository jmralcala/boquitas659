import { describe, expect, it } from "vitest";
import { validatePassword } from "../../src/modules/auth/password-policy.js";

describe("validatePassword", () => {
  it("rechaza contraseñas de menos de 10 caracteres", () => {
    const result = validatePassword("corta123");
    expect(result).toMatchObject({ ok: false, reason: "too_short" });
    expect(result.ok === false && result.message).toMatch(/10 caracteres/);
  });

  it("rechaza contraseñas comunes de la lista local", () => {
    expect(validatePassword("1234567890")).toMatchObject({ ok: false, reason: "too_common" });
    expect(validatePassword("PASSWORD123")).toMatchObject({ ok: false, reason: "too_common" });
    expect(validatePassword("qwertyuiop")).toMatchObject({ ok: false, reason: "too_common" });
  });

  it("rechaza contraseñas iguales al correo o a partes del nombre", () => {
    expect(validatePassword("ana.perez@example.com", { email: "ana.perez@example.com" })).toMatchObject({
      ok: false,
      reason: "matches_identity",
    });
    expect(validatePassword("Fernanda Gutierrez", { name: "Fernanda Gutierrez" })).toMatchObject({
      ok: false,
      reason: "matches_identity",
    });
  });

  it("acepta 10 o más caracteres sin símbolos ni mayúsculas (sin reglas de composición)", () => {
    expect(validatePassword("solominusculas")).toEqual({ ok: true });
    expect(validatePassword("0123456789a")).toEqual({ ok: true });
    expect(validatePassword("una frase larga que se recuerda")).toEqual({ ok: true });
  });

  it("rechaza contraseñas demasiado largas (protección contra abuso)", () => {
    expect(validatePassword("x".repeat(129))).toMatchObject({ ok: false, reason: "too_long" });
    expect(validatePassword("frase-larga-".repeat(10))).toEqual({ ok: true });
  });

  it("los mensajes explican el motivo y no incluyen la contraseña", () => {
    const result = validatePassword("1234567890");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toContain("1234567890");
      expect(result.message.length).toBeGreaterThan(10);
    }
  });
});
