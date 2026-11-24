import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictError, NotFoundError, ValidationError } from "../../src/http/errors.js";
import { createFixedClock } from "../../src/lib/clock.js";
import { changeSiteSlug } from "../../src/modules/site/change-slug.js";
import { clearTables, createDoctor, createPublishedSite, createTestPool, createUser, resetDatabase } from "./helpers/db.js";

const pool = createTestPool();
const clock = createFixedClock(new Date("2026-06-15T14:00:00.000Z"));

beforeAll(async () => {
  await resetDatabase(pool);
});

beforeEach(async () => {
  await clearTables(pool);
});

afterAll(async () => {
  await pool.end();
});

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

async function setup() {
  const support = await createUser(pool, { role: "support", email: "soporte@example.com" });
  const doctor = await createDoctor(pool);
  await createPublishedSite(pool, doctor, { slug: "clinica-rios" });
  return { support, doctor };
}

describe("changeSiteSlug (procedimiento de soporte)", () => {
  it("cambia el nombre, libera el anterior y deja la acción con el rol soporte", async () => {
    const s = await setup();
    await changeSiteSlug(pool, clock, { supportEmail: "SOPORTE@example.com", currentSlug: "clinica-rios", newSlug: "dra-rios" });
    expect(await rows("SELECT slug FROM doctor_site")).toEqual([{ slug: "dra-rios" }]);
    expect(await rows("SELECT doctor_id, actor_user_id, actor_role, action, outcome FROM calendar_action_log")).toEqual([
      { doctor_id: s.doctor.doctorId, actor_user_id: s.support.id, actor_role: "support", action: "site_updated", outcome: "ok" },
    ]);
    // El nombre anterior queda libre para otro médico.
    const other = await createDoctor(pool);
    await createPublishedSite(pool, other, { slug: "clinica-rios" });
  });

  it("rechaza un nombre nuevo inválido o ya usado, y no cambia nada", async () => {
    await setup();
    const other = await createDoctor(pool);
    await createPublishedSite(pool, other, { slug: "ocupado" });
    await expect(changeSiteSlug(pool, clock, { supportEmail: "soporte@example.com", currentSlug: "clinica-rios", newSlug: "Mal Nombre" })).rejects.toBeInstanceOf(ValidationError);
    await expect(changeSiteSlug(pool, clock, { supportEmail: "soporte@example.com", currentSlug: "clinica-rios", newSlug: "ocupado" })).rejects.toBeInstanceOf(ConflictError);
    expect((await rows("SELECT slug FROM doctor_site ORDER BY slug")).map((row) => row.slug)).toEqual(["clinica-rios", "ocupado"]);
    expect(await rows("SELECT id FROM calendar_action_log")).toEqual([]);
  });

  it("exige una persona de soporte activa y un micrositio existente (coincidencia exacta)", async () => {
    await setup();
    await createUser(pool, { role: "doctor", email: "medico@example.com" });
    await expect(changeSiteSlug(pool, clock, { supportEmail: "medico@example.com", currentSlug: "clinica-rios", newSlug: "dra-rios" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(changeSiteSlug(pool, clock, { supportEmail: "nadie@example.com", currentSlug: "clinica-rios", newSlug: "dra-rios" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(changeSiteSlug(pool, clock, { supportEmail: "soporte@example.com", currentSlug: "no-existe", newSlug: "dra-rios" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(changeSiteSlug(pool, clock, { supportEmail: "soporte@example.com", currentSlug: "Clinica-Rios", newSlug: "dra-rios" })).rejects.toBeInstanceOf(NotFoundError);
    expect(await rows("SELECT slug FROM doctor_site")).toEqual([{ slug: "clinica-rios" }]);
  });
});
