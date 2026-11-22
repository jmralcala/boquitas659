import type { FastifyRequest, preHandlerHookHandler } from "fastify";
import type { Db } from "../../db/pool.js";
import { ForbiddenError } from "../../http/errors.js";
import { requireAuth } from "../../http/session-plugin.js";
import { findDoctorByUserId, type Doctor } from "./doctor-repository.js";

export interface DoctorGuards {
  /** Sesión de un usuario con rol de médico, sin importar el estado de aprobación. */
  requireDoctorAccount: preHandlerHookHandler;
  /** Médico con ficha y estado `approved`. Cualquier otro caso responde 403. */
  requireApprovedDoctor: preHandlerHookHandler;
  /** Ficha del médico de la sesión (para rutas que ya pasaron `requireDoctorAccount`). */
  loadDoctor(request: FastifyRequest): Promise<Doctor>;
}

export function createDoctorGuards(db: Db): DoctorGuards {
  async function loadDoctor(request: FastifyRequest): Promise<Doctor> {
    const auth = requireAuth(request);
    if (auth.role !== "doctor") throw new ForbiddenError();
    const doctor = await findDoctorByUserId(db, auth.userId);
    if (!doctor) throw new ForbiddenError();
    return doctor;
  }

  return {
    loadDoctor,
    requireDoctorAccount: async (request) => {
      const auth = requireAuth(request);
      if (auth.role !== "doctor") throw new ForbiddenError();
    },
    requireApprovedDoctor: async (request) => {
      const doctor = await loadDoctor(request);
      if (doctor.approvalStatus !== "approved") {
        throw new ForbiddenError("Tu cuenta aún no está aprobada.");
      }
    },
  };
}
