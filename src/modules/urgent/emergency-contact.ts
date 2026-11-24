import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import type { TenantContext } from "../../lib/tenant.js";

type Executor = Pick<Pool, "execute"> | Pick<PoolConnection, "execute">;

export interface EmergencyContact {
  /** Móvil de emergencias registrado del médico (10 dígitos); `null` si no tiene. */
  mobile: string | null;
  /** Teléfono del consultorio: el respaldo cuando no hay móvil. */
  officePhone: string | null;
}

const TEN_DIGITS = /^\d{10}$/;

/**
 * Cómo comunicarse con el médico cuando no hay espacio, el paciente marcó una señal de alarma o el CAPTCHA no está disponible.
 * Solo se muestra a pacientes con sesión en esas pantallas (el micrositio público no lo muestra) y solo si el formato es válido.
 */
export async function findEmergencyContact(ctx: TenantContext, executor: Executor): Promise<EmergencyContact> {
  const [rows] = await executor.execute<RowDataPacket[]>("SELECT emergency_mobile, office_phone FROM doctor WHERE id = ?", [ctx.doctorId]);
  const row = rows[0];
  const valid = (value: unknown): string | null => (typeof value === "string" && TEN_DIGITS.test(value) ? value : null);
  return { mobile: valid(row?.emergency_mobile), officePhone: valid(row?.office_phone) };
}
