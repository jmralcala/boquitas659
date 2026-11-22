declare const tenantBrand: unique symbol;

export type TenantActor =
  | { readonly kind: "doctor"; readonly userId: number }
  | { readonly kind: "reception"; readonly userId: number };

/**
 * Contexto de médico (tenant). Toda función que lee o escribe datos de pacientes, citas o agenda
 * MUST recibirlo como primer parámetro y filtrar por `doctorId`: no existen lecturas de pacientes sin él
 * (principio II de la constitución). El símbolo de marca impide fabricarlo con un objeto literal;
 * solo se obtiene con `createTenantContext`, que únicamente deben llamar los resolutores que ya
 * comprobaron que el actor pertenece a ese médico (el propio médico o recepción con vínculo vigente).
 */
export interface TenantContext {
  readonly [tenantBrand]: true;
  readonly doctorId: number;
  readonly actor: TenantActor;
}

export function createTenantContext(doctorId: number, actor: TenantActor): TenantContext {
  if (!Number.isInteger(doctorId) || doctorId <= 0) {
    throw new Error("doctorId inválido para el contexto de médico.");
  }
  return { doctorId, actor } as TenantContext;
}
