import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, linkTokenSentTo, type TestApp } from "./helpers/app.js";
import { clearTables, createDoctor, createMembership, createPatient, createTestPool, createUser, resetDatabase, type CreatedDoctor } from "./helpers/db.js";

const pool = createTestPool();
const DAY = 86_400_000;
let t: TestApp;
let doctor: CreatedDoctor;

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  await t.services.legal.publish({ type: "reception_privacy", title: "Aviso", body: "x", isProvisional: false });
  await t.services.legal.publish({ type: "reception_confidentiality", title: "Compromiso", body: "x", isProvisional: false });
  doctor = await createDoctor(pool, { fullName: "Dra. Invitadora" });
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return Number(rows[0]?.n);
}

const invite = (email: string, d = doctor) => t.services.invitations.invite(d.doctorId, d.user.id, email);

/** Invita, envía el correo y acepta como persona nueva. */
async function inviteAndAccept(email: string, d = doctor): Promise<void> {
  await invite(email, d);
  const token = await linkTokenSentTo(t, email, "/recepcion/invitacion");
  await t.services.invitations.accept(token, {
    fullName: "Persona de Recepción",
    password: "una frase larga que se recuerda",
    acceptPrivacy: "yes",
    acceptConfidentiality: "yes",
  });
}

describe("límite de 2 personas de recepción por médico", () => {
  it("la tercera invitación se rechaza (pendientes + activas)", async () => {
    await invite("uno@example.com");
    await invite("dos@example.com");
    await expect(invite("tres@example.com")).rejects.toMatchObject({ status: 409 });
    expect(await count("SELECT COUNT(*) AS n FROM reception_invitation")).toBe(2);
  });

  it("las personas activas cuentan igual que las invitaciones pendientes", async () => {
    await inviteAndAccept("uno@example.com");
    await invite("dos@example.com");
    await expect(invite("tres@example.com")).rejects.toMatchObject({ status: 409 });
  });

  it("revocar una invitación o retirar a una persona libera un lugar", async () => {
    const first = await invite("uno@example.com");
    await invite("dos@example.com");
    await expect(invite("tres@example.com")).rejects.toMatchObject({ status: 409 });

    await t.services.invitations.revoke(doctor.doctorId, doctor.user.id, first.invitationId);
    await invite("tres@example.com");
    await expect(invite("cuatro@example.com")).rejects.toMatchObject({ status: 409 });
    expect(await count("SELECT COUNT(*) AS n FROM reception_invitation WHERE status = 'revoked'")).toBe(1);
  });

  it("retirar a una persona activa libera su lugar", async () => {
    await inviteAndAccept("uno@example.com");
    await inviteAndAccept("dos@example.com");
    await expect(invite("tres@example.com")).rejects.toMatchObject({ status: 409 });

    const [rows] = await pool.query<RowDataPacket[]>("SELECT id FROM reception_membership ORDER BY id LIMIT 1");
    await t.services.memberships.remove(doctor.doctorId, doctor.user.id, Number(rows[0]?.id));
    await invite("tres@example.com");
    expect(await count("SELECT COUNT(*) AS n FROM reception_membership WHERE revoked_at IS NULL")).toBe(1);
  });

  it("con invitaciones simultáneas nunca se supera 2", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => invite(`simultanea${i}@example.com`)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(4);
    expect(await count("SELECT COUNT(*) AS n FROM reception_invitation WHERE status = 'pending'")).toBe(2);
  });

  it("las invitaciones vencidas ya no cuentan", async () => {
    await invite("uno@example.com");
    await invite("dos@example.com");
    t.clock.advance(7 * DAY + 1000);
    await invite("tres@example.com");
    expect(await count("SELECT COUNT(*) AS n FROM reception_invitation")).toBe(3);
  });

  it("el límite es por médico: otro médico puede invitar a sus propias 2 personas", async () => {
    const other = await createDoctor(pool);
    await invite("uno@example.com");
    await invite("dos@example.com");
    await invite("otro1@example.com", other);
    await invite("otro2@example.com", other);
    await expect(invite("otro3@example.com", other)).rejects.toMatchObject({ status: 409 });
  });
});

describe("validaciones de la invitación", () => {
  it("normaliza el correo y rechaza formatos inválidos", async () => {
    const result = await invite("  Persona@Example.COM ");
    expect(await count("SELECT COUNT(*) AS n FROM reception_invitation WHERE email_normalized = 'persona@example.com'")).toBe(1);
    expect(result.invitationId).toBeGreaterThan(0);
    await expect(invite("no-es-correo")).rejects.toMatchObject({ status: 400 });
  });

  it("rechaza una segunda invitación pendiente al mismo correo y a quien ya trabaja con el médico", async () => {
    await invite("uno@example.com");
    await expect(invite("UNO@example.com")).rejects.toMatchObject({ status: 400 });

    const person = await createUser(pool, { role: "reception", email: "activa@example.com" });
    await createMembership(pool, doctor.doctorId, person.id);
    await expect(invite("activa@example.com")).rejects.toMatchObject({ status: 400 });
  });

  it("un correo que ya existe con otro rol se rechaza con mensaje genérico que no revela el rol", async () => {
    await createPatient(pool, { email: "paciente@example.com" });
    const other = await createDoctor(pool, { email: "colega@example.com" });
    for (const email of ["paciente@example.com", "colega@example.com"]) {
      const error = await invite(email).catch((e: unknown) => e as { status: number; fields?: Record<string, string[]> });
      expect((error as { status: number }).status).toBe(400);
      const text = JSON.stringify((error as { fields?: unknown }).fields);
      expect(text).not.toMatch(/paciente|médico|doctor|soporte|recepci/i);
    }
    expect(other.doctorId).toBeGreaterThan(0);
    expect(await count("SELECT COUNT(*) AS n FROM reception_invitation")).toBe(0);
  });

  it("una persona de recepción que ya tiene cuenta sí puede ser invitada por otro médico", async () => {
    const other = await createDoctor(pool);
    await createUser(pool, { role: "reception", email: "compartida@example.com" });
    await invite("compartida@example.com");
    await invite("compartida@example.com", other);
    expect(await count("SELECT COUNT(*) AS n FROM reception_invitation WHERE email_normalized = 'compartida@example.com'")).toBe(2);
  });

  it("solo un médico aprobado puede invitar", async () => {
    const pending = await createDoctor(pool, { status: "pending" });
    await expect(invite("uno@example.com", pending)).rejects.toMatchObject({ status: 403 });
  });

  it("encola el correo de invitación y registra la acción, sin token en claro", async () => {
    await invite("uno@example.com");
    expect(await count("SELECT COUNT(*) AS n FROM email_outbox WHERE template = 'reception_invitation' AND to_email = 'uno@example.com'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM one_time_token")).toBe(0);
    const [log] = await pool.query<RowDataPacket[]>("SELECT actor_user_id, doctor_id, action FROM reception_action_log");
    expect(log).toEqual([{ actor_user_id: doctor.user.id, doctor_id: doctor.doctorId, action: "invite" }]);
  });
});
