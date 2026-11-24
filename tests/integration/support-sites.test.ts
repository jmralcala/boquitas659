import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictError, NotFoundError, ValidationError } from "../../src/http/errors.js";
import { createTenantContext } from "../../src/lib/tenant.js";
import { SLUG_RESERVATION_DAYS } from "../../src/modules/site/change-slug.js";
import { chooseName } from "../../src/modules/site/site-service.js";
import { clearTables, createDoctor, createDoctorSite, createPublishedSite, createTestPool, createUser, ensurePrivacyDocument, resetDatabase, type CreatedDoctor } from "./helpers/db.js";
import { createTestApp, uniqueIp, type TestApp } from "./helpers/app.js";

const pool = createTestPool();
let t: TestApp;
let supportId: number;
const DAY = 86_400_000;

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  t.clock.set(new Date("2026-06-15T14:00:00.000Z"));
  await ensurePrivacyDocument(pool);
  supportId = (await createUser(pool, { role: "support" })).id;
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

async function clinic(slug: string): Promise<CreatedDoctor> {
  const doctor = await createDoctor(pool);
  await createPublishedSite(pool, doctor, { slug });
  return doctor;
}

const change = (doctor: CreatedDoctor, newSlug: string, reason = "el médico lo pidió") =>
  t.services.siteAdmin.changeSlug({ doctorId: doctor.doctorId, supportUserId: supportId, newSlug, reason });
const slugOf = async (doctor: CreatedDoctor) => (await rows("SELECT slug FROM doctor_site WHERE doctor_id = ?", [doctor.doctorId]))[0]?.slug as string;
const page = (slug: string) => t.app.inject({ method: "GET", url: `/c/${slug}`, remoteAddress: uniqueIp() });

describe("lista de micrositios", () => {
  it("cuenta por estado y filtra", async () => {
    await clinic("uno-publicado");
    await clinic("dos-publicado");
    const draftDoctor = await createDoctor(pool);
    await createDoctorSite(pool, draftDoctor.doctorId, { slug: "en-borrador", status: "draft" });
    const list = await t.services.siteAdmin.list("all");
    expect(list.counts).toEqual({ draft: 1, published: 2, unpublished: 0 });
    expect(list.rows).toHaveLength(3);
    expect((await t.services.siteAdmin.list("draft")).rows.map((row) => row.slug)).toEqual(["en-borrador"]);
    expect((await t.services.siteAdmin.list("published")).rows).toHaveLength(2);
    expect((await t.services.siteAdmin.list("unpublished")).rows).toEqual([]);
  });
});

describe("cambiar el nombre del enlace", () => {
  it("el nuevo funciona, el anterior da 404, queda reservado y se registra todo", async () => {
    const doctor = await clinic("clinica-rios");
    await change(doctor, "dra-rios", "cambio de marca");

    expect(await slugOf(doctor)).toBe("dra-rios");
    expect((await page("dra-rios")).statusCode).toBe(200);
    expect((await page("clinica-rios")).statusCode).toBe(404);

    const [reservation] = await rows("SELECT slug, doctor_id, reserved_until FROM site_slug_reservation");
    expect(reservation).toMatchObject({ slug: "clinica-rios", doctor_id: doctor.doctorId });
    expect((reservation?.reserved_until as Date).getTime()).toBe(t.clock.now().getTime() + SLUG_RESERVATION_DAYS * DAY);

    expect(await rows("SELECT actor_user_id, actor_role, action, outcome FROM calendar_action_log")).toEqual([
      { actor_user_id: supportId, actor_role: "support", action: "site_updated", outcome: "ok" },
    ]);
    expect(await rows("SELECT support_user_id, action, target_type, target_id, reason FROM support_action_log")).toEqual([
      { support_user_id: supportId, action: "change_slug", target_type: "site", target_id: doctor.doctorId, reason: "cambio de marca" },
    ]);
    const mail = await rows("SELECT to_email, payload_ref FROM email_outbox WHERE template = 'doctor_site_slug_changed'");
    expect(mail).toHaveLength(1);
    expect(mail[0]?.to_email).toBe(doctor.user.email);
    expect(JSON.parse(String(mail[0]?.payload_ref))).toEqual({ doctorId: doctor.doctorId, slug: "dra-rios" });
    expect(String(mail[0]?.payload_ref)).not.toContain("cambio de marca");
  });

  it("un nombre en uso es 409, un formato inválido es 400, y no se cambia nada", async () => {
    const doctor = await clinic("clinica-rios");
    await clinic("ocupado");
    await expect(change(doctor, "ocupado")).rejects.toBeInstanceOf(ConflictError);
    await expect(change(doctor, "Mal Nombre")).rejects.toBeInstanceOf(ValidationError);
    await expect(change(doctor, "ab")).rejects.toBeInstanceOf(ValidationError);
    expect(await slugOf(doctor)).toBe("clinica-rios");
    expect(await rows("SELECT id FROM support_action_log")).toEqual([]);
    expect(await rows("SELECT slug FROM site_slug_reservation")).toEqual([]);
  });

  it("un médico sin micrositio o inexistente es 404", async () => {
    const without = await createDoctor(pool);
    await expect(change(without, "nuevo-nombre")).rejects.toBeInstanceOf(NotFoundError);
    await expect(t.services.siteAdmin.changeSlug({ doctorId: 999999, supportUserId: supportId, newSlug: "nuevo-nombre", reason: "x" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("el mismo dueño puede recuperar su nombre anterior", async () => {
    const doctor = await clinic("clinica-rios");
    await change(doctor, "dra-rios");
    await change(doctor, "clinica-rios", "volver al nombre original");
    expect(await slugOf(doctor)).toBe("clinica-rios");
    // El nombre recuperado deja de estar reservado; el que se dejó (dra-rios) ahora sí lo está.
    expect((await rows("SELECT slug FROM site_slug_reservation")).map((row) => row.slug)).toEqual(["dra-rios"]);
  });

  it("otro médico no puede tomar un nombre reservado, ni al crear ni al cambiar, hasta que vence la reserva", async () => {
    const first = await clinic("clinica-rios");
    await change(first, "dra-rios");

    // Cambio por soporte hacia un nombre reservado por otro consultorio.
    const second = await clinic("otro-consultorio");
    await expect(change(second, "clinica-rios")).rejects.toMatchObject({ code: "slug_taken" });

    // Creación por el propio médico (primer nombre del micrositio).
    const newcomer = await createDoctor(pool);
    const ctx = createTenantContext(newcomer.doctorId, { kind: "doctor", userId: newcomer.user.id });
    await expect(chooseName(ctx, { db: pool, clock: t.clock } as never, "clinica-rios")).rejects.toMatchObject({ code: "slug_taken" });

    // Pasados los 90 días el nombre queda libre.
    t.clock.set(new Date(t.clock.now().getTime() + (SLUG_RESERVATION_DAYS + 1) * DAY));
    await change(second, "clinica-rios");
    expect(await slugOf(second)).toBe("clinica-rios");
  });

  it("dos cambios simultáneos al mismo nombre terminan con un solo ganador", async () => {
    const a = await clinic("uno-original");
    const b = await clinic("dos-original");
    const results = await Promise.allSettled([change(a, "nombre-disputado"), change(b, "nombre-disputado")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await rows("SELECT slug FROM doctor_site WHERE slug = 'nombre-disputado'"))).toHaveLength(1);
  });

});
