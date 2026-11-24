import { z } from "zod";
import type { AccountState } from "../doctors/doctor-repository.js";

/** Acciones que cambian el estado operativo de la cuenta de un médico (feature 5). */
export type StateAction = "suspend" | "read_only" | "reactivate";

/** Estados de los que se puede partir con cada acción. */
const FROM_STATES: Readonly<Record<StateAction, readonly AccountState[]>> = {
  suspend: ["active", "read_only"],
  read_only: ["active"],
  reactivate: ["suspended", "read_only"],
};

const TARGET: Readonly<Record<StateAction, AccountState>> = {
  suspend: "suspended",
  read_only: "read_only",
  reactivate: "active",
};

export function canTransition(from: AccountState, action: StateAction): boolean {
  return FROM_STATES[action].includes(from);
}

/** Estado al que lleva la acción; lanza si la transición no es válida (el servicio lo traduce a 409). */
export function nextState(from: AccountState, action: StateAction): AccountState {
  if (!canTransition(from, action)) throw new Error(`Transición no válida: ${action} desde ${from}.`);
  return TARGET[action];
}

/** Correo enmascarado: primera letra y dominio (`j***@dominio.com`). Un texto sin arroba no se devuelve. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

/**
 * Estado de la cuenta frente a una petición del médico o de su recepción (feature 5): una cuenta suspendida no opera y una
 * en solo lectura solo admite `GET` y `HEAD`. Es la regla única que aplican el resolutor de médico y las guardas.
 */
export function accountAllows(state: AccountState, method: string): "ok" | "suspended" | "read_only" {
  if (state === "active") return "ok";
  if (state === "suspended") return "suspended";
  return method === "GET" || method === "HEAD" ? "ok" : "read_only";
}

// --- Esquemas de entrada compartidos por las rutas del panel -------------------------------------------------------

export const MAX_REASON = 500;

/** Motivo interno de una acción: texto recortado de 1 a 500 caracteres. */
export const reasonSchema = z
  .string({ error: "Escribe el motivo." })
  .transform((value) => value.trim())
  .pipe(z.string().min(1, "Escribe el motivo.").max(MAX_REASON, `El motivo no puede pasar de ${MAX_REASON} caracteres.`));

/** Casilla de confirmación: el valor debe ser exactamente `yes`. */
export const confirmSchema = z.literal("yes", { error: "Confirma la acción marcando la casilla." });

export const idParams = z.object({
  id: z.coerce.number({ error: "Id inválido." }).int("Id inválido.").positive("Id inválido."),
});

export const pageQuery = z.object({
  pagina: z.coerce.number({ error: "Página inválida." }).int("Página inválida.").min(1, "Página inválida.").max(100_000, "Página inválida.").default(1),
});

/** Cuerpo común de las acciones de cambio: motivo y confirmación. */
export const actionBody = z.object({ reason: reasonSchema, confirm: confirmSchema });

/** Cuerpo de un cambio de estado: además, el estado que la persona vio (para detectar cambios simultáneos). */
export const stateActionBody = actionBody.extend({
  from: z.enum(["active", "suspended", "read_only"], { error: "Estado inválido." }),
});
