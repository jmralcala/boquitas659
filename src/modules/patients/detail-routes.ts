import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Services } from "../../compose.js";
import { NotFoundError } from "../../http/errors.js";
import { wantsJson } from "../../http/negotiation.js";
import { parseInput } from "../../http/validate.js";
import { page } from "../../http/views/layout.js";
import { calculateAge, todayInZone } from "../../lib/age.js";
import { html } from "../../lib/html.js";
import { logPatientAccess } from "../audit/access-log.js";
import { findPatientForDoctor, findTutorForMinor } from "./patient-repository.js";
import { OFFICE_TIME_ZONE } from "./registration-service.js";

const params = z.object({
  patientId: z.coerce.number({ error: "Id inválido." }).int("Id inválido.").positive("Id inválido."),
});

function ageLabel(age: number): string {
  return age === 1 ? "1 año" : `${age} años`;
}

/**
 * Detalle de contacto de un paciente para el médico y su recepción. Se obtiene el contexto de médico (recepción solo
 * con vínculo vigente EN ESTE MOMENTO), se consulta SIEMPRE filtrando por ese médico y el acceso se registra
 * (permitido o denegado) antes de responder. Un paciente de otro médico y uno inexistente dan el mismo 404.
 */
export function registerPatientDetailRoutes(app: FastifyInstance, services: Services): void {
  // 120 consultas por minuto y por IP: cada intento (también el denegado) deja una fila que no se puede borrar.
  app.get("/agenda/pacientes/:patientId", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (request, reply) => {
    const tenant = await services.tenants.resolve(request);
    const { patientId } = parseInput(params, request.params);

    const patient = await findPatientForDoctor(tenant, services.db, patientId);
    await logPatientAccess(services.db, {
      actorUserId: tenant.actor.userId,
      actorRole: tenant.actor.kind,
      doctorId: tenant.doctorId,
      patientId,
      outcome: patient ? "allowed" : "denied",
      at: services.clock.now(),
    });
    if (!patient) throw new NotFoundError();

    // La edad se calcula con la fecha de nacimiento a la fecha de hoy en la zona horaria del consultorio.
    const age = calculateAge(patient.birthDate, todayInZone(services.clock.now(), OFFICE_TIME_ZONE));
    const tutor = patient.isMinorDependent ? await findTutorForMinor(tenant, services.db, patient.id) : null;

    if (wantsJson(request)) {
      return reply.send({
        id: patient.id,
        fullName: patient.fullName,
        phone: patient.phone,
        email: patient.email,
        age,
        isMinorDependent: patient.isMinorDependent,
        tutor: tutor ? { fullName: tutor.fullName, phone: tutor.phone, email: tutor.email } : null,
      });
    }
    return reply.type("text/html; charset=utf-8").send(
      page({
        title: patient.fullName,
        content: html`<h1>${patient.fullName}</h1>
<dl>
  <dt>Edad</dt><dd>${ageLabel(age)}</dd>
  <dt>Teléfono</dt><dd>${patient.phone ?? "—"}</dd>
  <dt>Correo</dt><dd>${patient.email ?? "—"}</dd>
</dl>
${
  tutor
    ? html`<h2>Tutor</h2>
<dl>
  <dt>Nombre</dt><dd>${tutor.fullName}</dd>
  <dt>Teléfono</dt><dd>${tutor.phone ?? "—"}</dd>
  <dt>Correo</dt><dd>${tutor.email ?? "—"}</dd>
</dl>`
    : null
}`,
      }),
    );
  });
}
