import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, SiteUnavailableError, UnauthorizedError } from "../../src/http/errors.js";
import type { SessionData } from "../../src/modules/auth/sessions.js";
import { createSiteResolver } from "../../src/modules/site/site-resolver.js";
import { clearTables, createDoctor, createDoctorSite, createPatient, createPublishedSite, createTestPool, resetDatabase } from "./helpers/db.js";

const pool = createTestPool();
const resolver = createSiteResolver(pool);

beforeAll(async () => {
  await resetDatabase(pool);
});

beforeEach(async () => {
  await clearTables(pool);
});

afterAll(async () => {
  await pool.end();
});

function session(userId: number, role: SessionData["role"] = "patient", overrides: Partial<SessionData> = {}): SessionData {
  return { sessionId: 1, userId, role, activeDoctorId: null, mfaEnabled: false, mfaVerified: false, csrfSecret: "x", ...overrides };
}

describe("resolveSite", () => {
  it("un micrositio publicado con médico aprobado devuelve los datos públicos (y nada más)", async () => {
    const doctor = await createDoctor(pool, { fullName: "Dra. Elena Ríos" });
    const { slug } = await createPublishedSite(pool, doctor, { slug: "clinica-rios" });
    const view = await resolver.resolveSite(slug);
    expect(view).toEqual({
      kind: "published",
      site: { doctorId: doctor.doctorId, slug: "clinica-rios", doctorName: "Dra. Elena Ríos", officePhone: "5598765432", address: "Calle Falsa 123, Centro", logoFile: null },
    });
  });

  it("nunca publicado (borrador) y nombre inexistente son indistinguibles", async () => {
    const doctor = await createDoctor(pool);
    await createDoctorSite(pool, doctor.doctorId, { slug: "en-borrador", status: "draft" });
    expect(await resolver.resolveSite("en-borrador")).toEqual({ kind: "missing" });
    expect(await resolver.resolveSite("no-existe-nada")).toEqual({ kind: "missing" });
  });

  it("despublicado, tras haberse publicado, devuelve solo el aviso con nombre y teléfono", async () => {
    const doctor = await createDoctor(pool, { fullName: "Dr. Mario Soto" });
    await createPublishedSite(pool, doctor, { slug: "clinica-soto" });
    await pool.execute("UPDATE doctor_site SET status = 'unpublished' WHERE doctor_id = ?", [doctor.doctorId]);
    expect(await resolver.resolveSite("clinica-soto")).toEqual({ kind: "unavailable", doctorName: "Dr. Mario Soto", officePhone: "5598765432" });
  });

  it("un médico que dejó de estar aprobado muestra el aviso aunque el micrositio siga publicado", async () => {
    const doctor = await createDoctor(pool, { fullName: "Dr. Suspendido" });
    await createPublishedSite(pool, doctor, { slug: "dr-suspendido" });
    await pool.execute("UPDATE doctor SET approval_status = 'rejected' WHERE id = ?", [doctor.doctorId]);
    expect(await resolver.resolveSite("dr-suspendido")).toMatchObject({ kind: "unavailable", doctorName: "Dr. Suspendido" });
  });

  it("un médico pendiente cuyo micrositio nunca se publicó responde como inexistente", async () => {
    const doctor = await createDoctor(pool, { status: "pending" });
    await createDoctorSite(pool, doctor.doctorId, { slug: "pendiente", status: "draft" });
    expect(await resolver.resolveSite("pendiente")).toEqual({ kind: "missing" });
  });

  it("busca por el nombre exacto: mayúsculas, espacios y fragmentos no encuentran nada", async () => {
    const doctor = await createDoctor(pool);
    await createPublishedSite(pool, doctor, { slug: "clinica-rios" });
    for (const slug of ["Clinica-Rios", " clinica-rios", "clinica", "clinica-rios%", "clinica-rios/", "clinica_rios", ""]) {
      expect(await resolver.resolveSite(slug), slug).toEqual({ kind: "missing" });
    }
  });
});

describe("resolvePatientSite", () => {
  it("con sesión de paciente devuelve el contexto de paciente con el médico del micrositio, nunca de otro dato", async () => {
    const doctor = await createDoctor(pool);
    const other = await createDoctor(pool);
    await createPublishedSite(pool, doctor, { slug: "clinica-uno" });
    await createPublishedSite(pool, other, { slug: "clinica-dos" });
    const patient = await createPatient(pool);
    const resolved = await resolver.resolvePatientSite(session(patient.user.id), "clinica-uno");
    expect(resolved.ctx.doctorId).toBe(doctor.doctorId);
    expect(resolved.ctx.actor).toEqual({ kind: "patient", userId: patient.user.id });
    expect(resolved.site.slug).toBe("clinica-uno");
    expect((await resolver.resolvePatientSite(session(patient.user.id), "clinica-dos")).ctx.doctorId).toBe(other.doctorId);
  });

  it("sin sesión (o con la sesión a medias por falta del segundo factor) lanza UnauthorizedError", async () => {
    const doctor = await createDoctor(pool);
    await createPublishedSite(pool, doctor, { slug: "clinica-uno" });
    await expect(resolver.resolvePatientSite(null, "clinica-uno")).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(resolver.resolvePatientSite(session(1, "patient", { mfaEnabled: true, mfaVerified: false }), "clinica-uno")).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it.each(["doctor", "reception", "support"] as const)("el rol %s recibe ForbiddenError", async (role) => {
    const doctor = await createDoctor(pool);
    await createPublishedSite(pool, doctor, { slug: "clinica-uno" });
    await expect(resolver.resolvePatientSite(session(9, role), "clinica-uno")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("un micrositio despublicado, no aprobado o inexistente no acepta reservas", async () => {
    const doctor = await createDoctor(pool);
    await createPublishedSite(pool, doctor, { slug: "clinica-uno" });
    const patient = await createPatient(pool);
    await pool.execute("UPDATE doctor_site SET status = 'unpublished'");
    await expect(resolver.resolvePatientSite(session(patient.user.id), "clinica-uno")).rejects.toBeInstanceOf(SiteUnavailableError);
    await pool.execute("UPDATE doctor_site SET status = 'published'");
    await pool.execute("UPDATE doctor SET approval_status = 'rejected'");
    await expect(resolver.resolvePatientSite(session(patient.user.id), "clinica-uno")).rejects.toBeInstanceOf(SiteUnavailableError);
    await expect(resolver.resolvePatientSite(session(patient.user.id), "no-existe")).rejects.toMatchObject({ status: 404 });
  });
});
