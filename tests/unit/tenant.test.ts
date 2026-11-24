import { describe, expect, it } from "vitest";
import { createPatientContext, createTenantContext, isStaffContext, type StaffContext, type TenantContext } from "../../src/lib/tenant.js";

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

describe("contexto de paciente", () => {
  it("se crea con el médico del micrositio y la cuenta del paciente", () => {
    const ctx = createPatientContext(5, 42);
    expect(ctx.doctorId).toBe(5);
    expect(ctx.actor).toEqual({ kind: "patient", userId: 42 });
  });

  it("rechaza identificadores inválidos", () => {
    expect(() => createPatientContext(0, 1)).toThrow();
    expect(() => createPatientContext(1, 0)).toThrow();
    expect(() => createPatientContext(1, 2.5)).toThrow();
  });

  it("isStaffContext distingue al personal del paciente", () => {
    expect(isStaffContext(createTenantContext(1, { kind: "doctor", userId: 1 }))).toBe(true);
    expect(isStaffContext(createTenantContext(1, { kind: "reception", userId: 2 }))).toBe(true);
    expect(isStaffContext(createPatientContext(1, 3))).toBe(false);
  });

  it("un contexto de paciente no es un StaffContext (comprobación de tipos)", () => {
    const patient: TenantContext = createPatientContext(1, 3);
    // @ts-expect-error Un TenantContext cualquiera no se puede pasar donde se exige StaffContext.
    const asStaff: StaffContext = patient;
    expect(asStaff.doctorId).toBe(1);
    if (isStaffContext(patient)) throw new Error("No debería ser del personal");
  });

  it("el contexto del personal sí se acepta donde se pide TenantContext", () => {
    const staff: StaffContext = createTenantContext(1, { kind: "doctor", userId: 1 });
    const generic: TenantContext = staff;
    expect(generic.actor.kind).toBe("doctor");
  });
});
