import type { FastifyRequest } from "fastify";
import type { Db } from "../../db/pool.js";
import { ForbiddenError } from "../../http/errors.js";
import { requireAuth } from "../../http/session-plugin.js";
import { createTenantContext, type StaffContext } from "../../lib/tenant.js";
import { findDoctorById, findDoctorByUserId, type AccountState } from "../doctors/doctor-repository.js";
import { accountAllows } from "../support/state-rules.js";
import { hasActiveMembership } from "./reception-repository.js";

export interface TenantResolver {
  /**
   * Contexto de médico para la petición. Es la ÚNICA vía para obtener un `TenantContext` desde una sesión:
   * - médico: debe estar aprobado;
   * - recepción: debe tener un médico activo y el vínculo con él debe seguir vigente EN ESTE MOMENTO
   *   (se revalida en cada petición, sin confiar en lo que la sesión recordaba).
   */
  resolve(request: FastifyRequest): Promise<StaffContext>;
}

/** Estado de la cuenta del médico con el que se resolvió cada petición (para avisar de «solo lectura» en las páginas). */
const stateByRequest = new WeakMap<FastifyRequest, AccountState>();
export function accountStateOf(request: FastifyRequest): AccountState | undefined {
  return stateByRequest.get(request);
}

/** Rechaza la petición si el estado de la cuenta del médico no la admite (suspendida, o escritura en solo lectura). */
export function assertAccountAllows(state: Parameters<typeof accountAllows>[0], method: string): void {
  const verdict = accountAllows(state, method);
  if (verdict === "suspended") throw new ForbiddenError();
  if (verdict === "read_only") throw new ForbiddenError("Tu cuenta está en solo lectura.");
}

export function createTenantResolver(db: Db): TenantResolver {
  return {
    async resolve(request) {
      const auth = requireAuth(request);
      if (auth.role === "doctor") {
        const doctor = await findDoctorByUserId(db, auth.userId);
        if (!doctor || doctor.approvalStatus !== "approved") throw new ForbiddenError();
        assertAccountAllows(doctor.accountState, request.method);
        stateByRequest.set(request, doctor.accountState);
        return createTenantContext(doctor.id, { kind: "doctor", userId: auth.userId });
      }
      if (auth.role === "reception") {
        if (auth.activeDoctorId === null) throw new ForbiddenError("Elige con qué médico trabajas.");
        if (!(await hasActiveMembership(db, auth.userId, auth.activeDoctorId))) throw new ForbiddenError();
        const clinic = await findDoctorById(db, auth.activeDoctorId);
        if (!clinic) throw new ForbiddenError();
        assertAccountAllows(clinic.accountState, request.method);
        stateByRequest.set(request, clinic.accountState);
        return createTenantContext(auth.activeDoctorId, { kind: "reception", userId: auth.userId });
      }
      throw new ForbiddenError();
    },
  };
}
