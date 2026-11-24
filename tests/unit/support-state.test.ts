import { describe, expect, it } from "vitest";
import { canTransition, maskEmail, nextState, reasonSchema, type StateAction } from "../../src/modules/support/state-rules.js";

describe("transiciones del estado de la cuenta", () => {
  const valid: Array<[StateAction, "active" | "suspended" | "read_only", "active" | "suspended" | "read_only"]> = [
    ["suspend", "active", "suspended"],
    ["suspend", "read_only", "suspended"],
    ["read_only", "active", "read_only"],
    ["reactivate", "suspended", "active"],
    ["reactivate", "read_only", "active"],
  ];

  it.each(valid)("%s desde %s lleva a %s", (action, from, to) => {
    expect(canTransition(from, action)).toBe(true);
    expect(nextState(from, action)).toBe(to);
  });

  it("rechaza todas las demás combinaciones", () => {
    const states = ["active", "suspended", "read_only"] as const;
    const actions: StateAction[] = ["suspend", "read_only", "reactivate"];
    const allowed = new Set(valid.map(([action, from]) => `${action}:${from}`));
    for (const action of actions) {
      for (const from of states) {
        if (allowed.has(`${action}:${from}`)) continue;
        expect(canTransition(from, action), `${action} desde ${from}`).toBe(false);
        expect(() => nextState(from, action)).toThrow();
      }
    }
  });
});

describe("enmascarado de correo", () => {
  it("deja la primera letra y el dominio completo", () => {
    expect(maskEmail("juan.perez@example.com")).toBe("j***@example.com");
  });

  it("con una sola letra antes de la arroba no revela nada más", () => {
    expect(maskEmail("a@example.com")).toBe("a***@example.com");
  });

  it("conserva dominios con subdominios", () => {
    expect(maskEmail("maria@mail.clinica.example.com.mx")).toBe("m***@mail.clinica.example.com.mx");
  });

  it("un texto sin arroba no se devuelve tal cual", () => {
    expect(maskEmail("sin-arroba")).toBe("***");
  });
});

describe("motivo de una acción de soporte", () => {
  it("se recorta y acepta de 1 a 500 caracteres", () => {
    expect(reasonSchema.parse("  cuenta duplicada  ")).toBe("cuenta duplicada");
    expect(reasonSchema.parse("x".repeat(500))).toHaveLength(500);
  });

  it("rechaza vacío, solo espacios y más de 500 caracteres", () => {
    expect(reasonSchema.safeParse("").success).toBe(false);
    expect(reasonSchema.safeParse("    ").success).toBe(false);
    expect(reasonSchema.safeParse("x".repeat(501)).success).toBe(false);
  });
});
