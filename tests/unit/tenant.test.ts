import { describe, expect, it } from "vitest";
import { createTenantContext, type TenantContext } from "../../src/lib/tenant.js";

describe("TenantContext", () => {
  it("se crea con el médico y el actor", () => {
    const ctx = createTenantContext(5, { kind: "reception", userId: 9 });
    expect(ctx.doctorId).toBe(5);
    expect(ctx.actor).toEqual({ kind: "reception", userId: 9 });
  });

  it("rechaza identificadores inválidos", () => {
    expect(() => createTenantContext(0, { kind: "doctor", userId: 1 })).toThrow();
    expect(() => createTenantContext(1.5, { kind: "doctor", userId: 1 })).toThrow();
    expect(() => createTenantContext(-3, { kind: "doctor", userId: 1 })).toThrow();
  });

  it("no se puede fabricar con un objeto literal (comprobación de tipos)", () => {
    // @ts-expect-error Falta la marca interna: solo createTenantContext produce un TenantContext.
    const falso: TenantContext = { doctorId: 1, actor: { kind: "doctor", userId: 1 } };
    expect(falso.doctorId).toBe(1);
  });
});
