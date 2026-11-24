import type { FastifyRequest } from "fastify";
import type { Db } from "../../db/pool.js";
import { ForbiddenError } from "../../http/errors.js";
import { requireAuth } from "../../http/session-plugin.js";
import { createTenantContext, type StaffContext } from "../../lib/tenant.js";
import { findDoctorByUserId } from "../doctors/doctor-repository.js";
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

export function createTenantResolver(db: Db): TenantResolver {
  return {
    async resolve(request) {
      const auth = requireAuth(request);
      if (auth.role === "doctor") {
        const doctor = await findDoctorByUserId(db, auth.userId);
        if (!doctor || doctor.approvalStatus !== "approved") throw new ForbiddenError();
        return createTenantContext(doctor.id, { kind: "doctor", userId: auth.userId });
      }
      if (auth.role === "reception") {
        if (auth.activeDoctorId === null) throw new ForbiddenError("Elige con qué médico trabajas.");
        if (!(await hasActiveMembership(db, auth.userId, auth.activeDoctorId))) throw new ForbiddenError();
        return createTenantContext(auth.activeDoctorId, { kind: "reception", userId: auth.userId });
      }
      throw new ForbiddenError();
    },
  };
}
