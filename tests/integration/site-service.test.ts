import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RowDataPacket } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictError, ForbiddenError, ValidationError } from "../../src/http/errors.js";
import { createFixedClock } from "../../src/lib/clock.js";
import { createTenantContext, type StaffContext } from "../../src/lib/tenant.js";
import { createLogoStorage } from "../../src/modules/site/logo-storage.js";
import { SitePublishIncompleteError, chooseName, publish, removeLogo, replaceLogo, saveAddress, siteStatus, unpublish, type SiteDeps } from "../../src/modules/site/site-service.js";
import {
  clearTables,
  createAppointment,
  createBlock,
  createCalendarHours,
  createCalendarSettings,
  createDoctor,
  createMembership,
  createPatient,
  createTestPool,
  createUser,
  linkPatientToDoctor,
  resetDatabase,
  WEEKDAY_HOURS,
  type CreatedDoctor,
} from "./helpers/db.js";

const pool = createTestPool();
const clock = createFixedClock(new Date("2026-06-15T14:00:00.000Z"));
let logoDir: string;
let deps: SiteDeps;

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 2)]);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);

beforeAll(async () => {
  await resetDatabase(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  clock.set(new Date("2026-06-15T14:00:00.000Z"));
  logoDir = mkdtempSync(join(tmpdir(), "boquitas-site-"));
  deps = { db: pool, clock, logos: createLogoStorage(logoDir) };
});

afterEach(() => {
  rmSync(logoDir, { recursive: true, force: true });
});

afterAll(async () => {
  await pool.end();
});

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

async function doctorCtx(options: { phone?: boolean; hours?: boolean; status?: "approved" | "pending" } = {}): Promise<{ doctor: CreatedDoctor; ctx: StaffContext }> {
  const doctor = await createDoctor(pool, { status: options.status ?? "approved" });
  if (options.phone !== false) await pool.execute("UPDATE doctor SET office_phone = '5598765432' WHERE id = ?", [doctor.doctorId]);
  if (options.hours !== false) {
    await createCalendarSettings(pool, doctor.doctorId);
    await createCalendarHours(pool, doctor.doctorId, WEEKDAY_HOURS);
  }
  return { doctor, ctx: createTenantContext(doctor.doctorId, { kind: "doctor", userId: doctor.user.id }) };
}

describe("chooseName", () => {
  it("guarda el nombre en borrador una sola vez", async () => {
    const { ctx, doctor } = await doctorCtx();
    await chooseName(ctx, deps, "clinica-sonrisa");
    expect(await rows("SELECT slug, status, first_published_at FROM doctor_site WHERE doctor_id = ?", [doctor.doctorId])).toEqual([
      { slug: "clinica-sonrisa", status: "draft", first_published_at: null },
    ]);
    await expect(chooseName(ctx, deps, "otro-nombre")).rejects.toMatchObject({ status: 409, code: "slug_locked" });
    expect((await rows("SELECT slug FROM doctor_site"))[0]?.slug).toBe("clinica-sonrisa");
  });

  it.each(["ab", "x".repeat(41), "Clinica", "clínica", "mi clinica", "-abc", "abc-", "a--b", "a/b", ""])("rechaza %j (400)", async (slug) => {
    const { ctx } = await doctorCtx();
    await expect(chooseName(ctx, deps, slug)).rejects.toBeInstanceOf(ValidationError);
    expect(await rows("SELECT * FROM doctor_site")).toEqual([]);
  });

  it("un nombre ya usado por otro médico responde slug_taken, aunque cambien mayúsculas", async () => {
    const a = await doctorCtx();
    const b = await doctorCtx();
    await chooseName(a.ctx, deps, "clinica-sonrisa");
    await expect(chooseName(b.ctx, deps, "clinica-sonrisa")).rejects.toMatchObject({ status: 409, code: "slug_taken" });
    expect(await rows("SELECT doctor_id FROM doctor_site")).toEqual([{ doctor_id: a.doctor.doctorId }]);
  });

  it("dos médicos que eligen el mismo nombre a la vez: exactamente uno lo obtiene", async () => {
    const a = await doctorCtx();
    const b = await doctorCtx();
    const results = await Promise.allSettled([chooseName(a.ctx, deps, "mismo-nombre"), chooseName(b.ctx, deps, "mismo-nombre")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected[0]?.reason).toMatchObject({ code: "slug_taken" });
    expect(await rows("SELECT slug FROM doctor_site")).toEqual([{ slug: "mismo-nombre" }]);
  });

  it("el mismo médico eligiendo dos nombres a la vez: solo se guarda uno", async () => {
    const { ctx } = await doctorCtx();
    const results = await Promise.allSettled([chooseName(ctx, deps, "primero-ok"), chooseName(ctx, deps, "segundo-ok")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await rows("SELECT slug FROM doctor_site")).toHaveLength(1);
  });

  it("registra site_updated con quién y cuándo", async () => {
    const { ctx, doctor } = await doctorCtx();
    await chooseName(ctx, deps, "clinica-sonrisa");
    expect(await rows("SELECT doctor_id, actor_user_id, actor_role, action, outcome FROM calendar_action_log")).toEqual([
      { doctor_id: doctor.doctorId, actor_user_id: doctor.user.id, actor_role: "doctor", action: "site_updated", outcome: "ok" },
    ]);
  });
});

describe("solo el médico administra su micrositio", () => {
  it("la recepción recibe ForbiddenError en todas las operaciones y no cambia nada", async () => {
    const { doctor, ctx } = await doctorCtx();
    await chooseName(ctx, deps, "clinica-sonrisa");
    const person = await createUser(pool, { role: "reception" });
    await createMembership(pool, doctor.doctorId, person.id);
    const reception = createTenantContext(doctor.doctorId, { kind: "reception", userId: person.id });
    const before = await rows("SELECT * FROM doctor_site");
    await expect(chooseName(reception, deps, "otro-nombre")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(saveAddress(reception, deps, "Calle 1")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(replaceLogo(reception, deps, png)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(removeLogo(reception, deps)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(publish(reception, deps)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(unpublish(reception, deps)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(siteStatus(reception, deps)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await rows("SELECT * FROM doctor_site")).toEqual(before);
    expect(readdirSync(logoDir)).toEqual([]);
  });

  it("un médico que no está aprobado no puede publicar (ForbiddenError)", async () => {
    const { ctx } = await doctorCtx({ status: "pending" });
    await chooseName(ctx, deps, "pendiente-ok");
    await saveAddress(ctx, deps, "Calle 1");
    await expect(publish(ctx, deps)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("saveAddress", () => {
  it("guarda la dirección recortada y exige que ya exista el nombre", async () => {
    const { ctx } = await doctorCtx();
    await expect(saveAddress(ctx, deps, "Calle 1")).rejects.toMatchObject({ status: 409, code: "site_without_name" });
    await chooseName(ctx, deps, "clinica-sonrisa");
    await saveAddress(ctx, deps, "  Calle Falsa 123, Centro  ");
    expect((await rows("SELECT address FROM doctor_site"))[0]?.address).toBe("Calle Falsa 123, Centro");
  });

  it.each([["", "vacía"], ["   ", "solo espacios"], ["x".repeat(301), "301 caracteres"], ["Calle\u0000 1", "con carácter de control"]])(
    "rechaza una dirección %s (400)",
    async (address) => {
      const { ctx } = await doctorCtx();
      await chooseName(ctx, deps, "clinica-sonrisa");
      await expect(saveAddress(ctx, deps, address)).rejects.toBeInstanceOf(ValidationError);
    },
  );

  it("acepta justo 300 caracteres", async () => {
    const { ctx } = await doctorCtx();
    await chooseName(ctx, deps, "clinica-sonrisa");
    await saveAddress(ctx, deps, "x".repeat(300));
    expect(String((await rows("SELECT address FROM doctor_site"))[0]?.address)).toHaveLength(300);
  });
});

describe("publicar y despublicar", () => {
  async function ready(options: Parameters<typeof doctorCtx>[0] = {}): Promise<{ doctor: CreatedDoctor; ctx: StaffContext }> {
    const made = await doctorCtx(options);
    await chooseName(made.ctx, deps, "clinica-sonrisa");
    await saveAddress(made.ctx, deps, "Calle Falsa 123");
    return made;
  }

  it("publica cuando está todo y fija first_published_at y published_at", async () => {
    const { ctx } = await ready();
    clock.set(new Date("2026-06-16T10:00:00.000Z"));
    await publish(ctx, deps);
    const [row] = await rows("SELECT status, first_published_at, published_at FROM doctor_site");
    expect(row?.status).toBe("published");
    expect((row?.first_published_at as Date).toISOString()).toBe("2026-06-16T10:00:00.000Z");
    expect((row?.published_at as Date).toISOString()).toBe("2026-06-16T10:00:00.000Z");
  });

  it("al volver a publicar conserva first_published_at y actualiza published_at", async () => {
    const { ctx } = await ready();
    clock.set(new Date("2026-06-16T10:00:00.000Z"));
    await publish(ctx, deps);
    await unpublish(ctx, deps);
    expect((await rows("SELECT status FROM doctor_site"))[0]?.status).toBe("unpublished");
    clock.set(new Date("2026-06-20T10:00:00.000Z"));
    await publish(ctx, deps);
    const [row] = await rows("SELECT status, first_published_at, published_at FROM doctor_site");
    expect(row?.status).toBe("published");
    expect((row?.first_published_at as Date).toISOString()).toBe("2026-06-16T10:00:00.000Z");
    expect((row?.published_at as Date).toISOString()).toBe("2026-06-20T10:00:00.000Z");
  });

  it("sin dirección, sin teléfono o sin franjas responde 409 con la lista de lo que falta y no publica", async () => {
    const noAddress = await doctorCtx();
    await chooseName(noAddress.ctx, deps, "sin-direccion");
    await expect(publish(noAddress.ctx, deps)).rejects.toMatchObject({ status: 409, code: "site_incomplete", missing: ["dirección"] });

    const noPhone = await doctorCtx({ phone: false });
    await chooseName(noPhone.ctx, deps, "sin-telefono");
    await saveAddress(noPhone.ctx, deps, "Calle 1");
    await expect(publish(noPhone.ctx, deps)).rejects.toMatchObject({ missing: ["teléfono del consultorio"] });

    const noHours = await doctorCtx({ hours: false });
    await chooseName(noHours.ctx, deps, "sin-horario");
    await saveAddress(noHours.ctx, deps, "Calle 1");
    await expect(publish(noHours.ctx, deps)).rejects.toMatchObject({ missing: ["horario de atención (al menos una franja)"] });

    const nothing = await doctorCtx({ phone: false, hours: false });
    const error = (await publish(nothing.ctx, deps).catch((e: unknown) => e)) as SitePublishIncompleteError;
    expect(error).toBeInstanceOf(SitePublishIncompleteError);
    expect(error.missing).toEqual(["nombre del enlace", "dirección", "teléfono del consultorio", "horario de atención (al menos una franja)"]);

    expect(await rows("SELECT status FROM doctor_site WHERE status <> 'draft'")).toEqual([]);
  });

  it("despublicar conserva las citas y los bloqueos existentes", async () => {
    const { doctor, ctx } = await ready();
    await publish(ctx, deps);
    const patient = await createPatient(pool);
    await linkPatientToDoctor(pool, doctor.doctorId, patient.patientId);
    const id = await createAppointment(pool, { doctorId: doctor.doctorId, patientId: patient.patientId, startUtc: new Date("2026-06-23T16:00:00.000Z") });
    const block = await createBlock(pool, { doctorId: doctor.doctorId, startUtc: new Date("2026-06-24T15:00:00.000Z"), endUtc: new Date("2026-06-24T17:00:00.000Z") });
    await unpublish(ctx, deps);
    expect(await rows("SELECT status FROM appointment WHERE id = ?", [id])).toEqual([{ status: "booked" }]);
    expect(await rows("SELECT id FROM calendar_block WHERE id = ?", [block])).toHaveLength(1);
  });

  it("despublicar un micrositio que nunca se publicó es un conflicto, y publicar sin nombre también", async () => {
    const { ctx } = await doctorCtx();
    await expect(unpublish(ctx, deps)).rejects.toBeInstanceOf(ConflictError);
    await expect(publish(ctx, deps)).rejects.toMatchObject({ code: "site_incomplete" });
  });

  it("cada cambio registra site_updated con quién y cuándo", async () => {
    const { ctx, doctor } = await ready();
    await publish(ctx, deps);
    await unpublish(ctx, deps);
    const log = await rows("SELECT actor_user_id, action, outcome FROM calendar_action_log ORDER BY id");
    expect(log).toHaveLength(4); // nombre, dirección, publicar y despublicar
    expect(log.every((row) => row.action === "site_updated" && row.outcome === "ok" && row.actor_user_id === doctor.user.id)).toBe(true);
  });
});

describe("logo", () => {
  async function named(): Promise<{ doctor: CreatedDoctor; ctx: StaffContext }> {
    const made = await doctorCtx();
    await chooseName(made.ctx, deps, "clinica-sonrisa");
    return made;
  }

  it("guarda el logo, lo reemplaza borrando el anterior y lo quita", async () => {
    const { ctx } = await named();
    await replaceLogo(ctx, deps, png);
    const first = String((await rows("SELECT logo_file FROM doctor_site"))[0]?.logo_file);
    expect(first).toMatch(/^[a-f0-9]{32}\.png$/);
    expect(readdirSync(logoDir)).toEqual([first]);

    await replaceLogo(ctx, deps, jpeg);
    const second = String((await rows("SELECT logo_file FROM doctor_site"))[0]?.logo_file);
    expect(second).toMatch(/\.jpg$/);
    expect(readdirSync(logoDir)).toEqual([second]);

    await removeLogo(ctx, deps);
    expect((await rows("SELECT logo_file FROM doctor_site"))[0]?.logo_file).toBeNull();
    expect(readdirSync(logoDir)).toEqual([]);
  });

  it("un archivo que no es una imagen válida se rechaza (400) sin guardar nada ni cambiar el logo actual", async () => {
    const { ctx } = await named();
    await replaceLogo(ctx, deps, png);
    const before = await rows("SELECT logo_file FROM doctor_site");
    for (const bad of [Buffer.from("<svg><script>alert(1)</script></svg>"), Buffer.alloc(0), Buffer.alloc(1_048_577, 0xff)]) {
      await expect(replaceLogo(ctx, deps, bad)).rejects.toBeInstanceOf(ValidationError);
    }
    expect(await rows("SELECT logo_file FROM doctor_site")).toEqual(before);
    expect(readdirSync(logoDir)).toHaveLength(1);
  });

  it("sin nombre elegido no hay dónde guardar el logo (409) y no queda ningún archivo", async () => {
    const { ctx } = await doctorCtx();
    await expect(replaceLogo(ctx, deps, png)).rejects.toMatchObject({ code: "site_without_name" });
    expect(readdirSync(logoDir)).toEqual([]);
  });
});

describe("siteStatus", () => {
  it("indica el estado y lo que falta para publicar", async () => {
    const { ctx } = await doctorCtx({ phone: false });
    expect(await siteStatus(ctx, deps)).toEqual({ site: null, missing: ["nombre del enlace", "dirección", "teléfono del consultorio"] });
    await chooseName(ctx, deps, "clinica-sonrisa");
    const status = await siteStatus(ctx, deps);
    expect(status.site?.slug).toBe("clinica-sonrisa");
    expect(status.missing).toEqual(["dirección", "teléfono del consultorio"]);
  });

  it("aislamiento: cada médico solo ve y cambia el suyo", async () => {
    const a = await doctorCtx();
    const b = await doctorCtx();
    await chooseName(a.ctx, deps, "consultorio-a");
    await saveAddress(a.ctx, deps, "Dirección de A");
    expect((await siteStatus(b.ctx, deps)).site).toBeNull();
    await chooseName(b.ctx, deps, "consultorio-b");
    await saveAddress(b.ctx, deps, "Dirección de B");
    expect(await rows("SELECT slug, address FROM doctor_site ORDER BY doctor_id")).toEqual([
      { slug: "consultorio-a", address: "Dirección de A" },
      { slug: "consultorio-b", address: "Dirección de B" },
    ]);
  });
});
