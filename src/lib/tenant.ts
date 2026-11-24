declare const tenantBrand: unique symbol;

export type StaffActor =
  | { readonly kind: "doctor"; readonly userId: number }
  | { readonly kind: "reception"; readonly userId: number };

export type PatientActor = { readonly kind: "patient"; readonly userId: number };

export type TenantActor = StaffActor | PatientActor;

/**
 * Contexto de médico (tenant). Toda función que lee o escribe datos de pacientes, citas o agenda
 * MUST recibirlo como primer parámetro y filtrar por `doctorId`: no existen lecturas de pacientes sin él
 * (principio II de la constitución). El símbolo de marca impide fabricarlo con un objeto literal;
 * solo se obtiene con `createTenantContext` (personal) o `createPatientContext` (paciente), que únicamente deben
 * llamar los resolutores que ya comprobaron la pertenencia del actor.
 *
 * Una función que muestra o cambia datos del consultorio (agenda, bloqueos, configuración, nombres de pacientes)
 * exige `StaffContext`: el compilador impide pasarle un contexto de paciente. Solo las operaciones que el paciente
 * también hace (leer la configuración, comprobar solapes, insertar su propia cita) aceptan `TenantContext`.
 */
export interface TenantContext {
  readonly [tenantBrand]: true;
  readonly doctorId: number;
  readonly actor: TenantActor;
}

/** Contexto cuyo actor es el médico o su recepción (nunca un paciente). */
export interface StaffContext extends TenantContext {
  readonly actor: StaffActor;
}

function assertDoctorId(doctorId: number): void {
  if (!Number.isInteger(doctorId) || doctorId <= 0) {
    throw new Error("doctorId inválido para el contexto de médico.");
  }
}

/** Contexto del personal. Solo lo llama el resolutor de médico (`createTenantResolver`). */
export function createTenantContext(doctorId: number, actor: StaffActor): StaffContext {
  assertDoctorId(doctorId);
  return { doctorId, actor } as StaffContext;
}

/**
 * Contexto de un paciente frente al consultorio de un micrositio. SOLO lo llama `site-resolver`, después de resolver
 * el médico desde el nombre del enlace y de comprobar la sesión de paciente.
 */
export function createPatientContext(doctorId: number, userId: number): TenantContext {
  assertDoctorId(doctorId);
  if (!Number.isInteger(userId) || userId <= 0) throw new Error("userId inválido para el contexto de paciente.");
  return { doctorId, actor: { kind: "patient", userId } } as TenantContext;
}

export function isStaffContext(ctx: TenantContext): ctx is StaffContext {
  return ctx.actor.kind === "doctor" || ctx.actor.kind === "reception";
}
