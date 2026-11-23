import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TooManyAttemptsError } from "../../src/http/errors.js";
import { createFixedClock } from "../../src/lib/clock.js";
import { createTenantContext, type TenantContext } from "../../src/lib/tenant.js";
import { issueTicket, listLinkedPatients, lookupPatientsByEmail, verifyTicket } from "../../src/modules/calendar/patient-picker.js";
import { clearTables, createDoctor, createMembership, createPatient, createTestPool, createUser, linkPatientToDoctor, resetDatabase } from "./helpers/db.js";

const pool = createTestPool();
const clock = createFixedClock(new Date("2026-06-15T18:00:00.000Z"));
const SECRET = "s".repeat(40);
const deps = { db: pool, clock, ticketSecret: SECRET };

beforeAll(async () => {
  await resetDatabase(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  clock.set(new Date("2026-06-15T18:00:00.000Z"));
});

afterAll(async () => {
  await pool.end();
});

async function doctorCtx(): Promise<{ ctx: TenantContext; doctorId: number; userId: number }> {
  const doctor = await createDoctor(pool);
  return { ctx: createTenantContext(doctor.doctorId, { kind: "doctor", userId: doctor.user.id }), doctorId: doctor.doctorId, userId: doctor.user.id };
}

async function addDependent(accountId: number, fullName: string): Promise<number> {
  const [result] = await pool.execute<import("mysql2/promise").ResultSetHeader>(
    "INSERT INTO patient (account_id, full_name, birth_date, is_minor_dependent) VALUES (?, ?, '2018-03-01', 1)",
    [accountId, fullName],
  );
  return result.insertId;
}

async function lookupRows(): Promise<RowDataPacket[]> {
  const [rows] = await pool.query<RowDataPacket[]>("SELECT actor_user_id, action, outcome, doctor_id FROM calendar_action_log ORDER BY id");
  return rows;
}

describe("listLinkedPatients", () => {
  it("lista solo a los pacientes vinculados con el médico, con id y nombre", async () => {
    const a = await doctorCtx();
    const b = await doctorCtx();
    const mine = await createPatient(pool, { fullName: "Ana Mía" });
    const theirs = await createPatient(pool, { fullName: "Beto Ajeno" });
    await linkPatientToDoctor(pool, a.doctorId, mine.patientId);
    await linkPatientToDoctor(pool, b.doctorId, theirs.patientId);
    const list = await listLinkedPatients(a.ctx, pool);
    expect(list).toEqual([{ patientId: mine.patientId, fullName: "Ana Mía" }]);
  });
});

describe("lookupPatientsByEmail", () => {
  it("devuelve los pacientes de la cuenta (titular y menores) con un boleto cada uno, sin teléfono ni fecha de nacimiento", async () => {
    const { ctx } = await doctorCtx();
    const owner = await createPatient(pool, { email: "tutora@example.com", fullName: "Tutora Principal" });
    const minorId = await addDependent(owner.accountId, "Menor Pequeño");

    const result = await lookupPatientsByEmail(ctx, deps, "tutora@example.com");
    expect(result.patients.map((p) => p.fullName)).toEqual(["Tutora Principal", "Menor Pequeño"]);
    expect(result.patients.map((p) => p.patientId)).toEqual([owner.patientId, minorId]);
    for (const patient of result.patients) {
      expect(Object.keys(patient).sort()).toEqual(["fullName", "patientId", "ticket"]);
      expect(verifyTicket(SECRET, ctx, patient.patientId, patient.ticket, clock.now())).toBe(true);
    }
    expect(JSON.stringify(result)).not.toContain("5512345678");
    expect(JSON.stringify(result)).not.toContain("1990-05-17");
  });

  it("normaliza el correo (mayúsculas y espacios) y exige que sea exacto", async () => {
    const { ctx } = await doctorCtx();
    await createPatient(pool, { email: "exacto@example.com" });
    expect((await lookupPatientsByEmail(ctx, deps, "  EXACTO@Example.COM ")).patients).toHaveLength(1);
    expect((await lookupPatientsByEmail(ctx, deps, "exacto@example.co")).patients).toEqual([]);
    expect((await lookupPatientsByEmail(ctx, deps, "exact")).patients).toEqual([]);
    expect((await lookupPatientsByEmail(ctx, deps, "%@example.com")).patients).toEqual([]);
  });

  it("sin cuenta devuelve lista vacía (mismo resultado que un correo mal escrito) y queda registrada como rejected", async () => {
    const { ctx, userId, doctorId } = await doctorCtx();
    await createPatient(pool, { email: "existe@example.com" });
    expect((await lookupPatientsByEmail(ctx, deps, "noexiste@example.com")).patients).toEqual([]);
    expect((await lookupPatientsByEmail(ctx, deps, "existe@example.com")).patients).toHaveLength(1);
    expect(await lookupRows()).toEqual([
      { actor_user_id: userId, action: "patient_lookup", outcome: "rejected", doctor_id: doctorId },
      { actor_user_id: userId, action: "patient_lookup", outcome: "ok", doctor_id: doctorId },
    ]);
  });

  it("ignora cuentas de otros roles o desactivadas con ese correo", async () => {
    const { ctx } = await doctorCtx();
    await createUser(pool, { role: "doctor", email: "medico@example.com" });
    const disabled = await createPatient(pool, { email: "baja@example.com" });
    await pool.execute("UPDATE `user` SET status = 'disabled' WHERE id = ?", [disabled.user.id]);
    expect((await lookupPatientsByEmail(ctx, deps, "medico@example.com")).patients).toEqual([]);
    expect((await lookupPatientsByEmail(ctx, deps, "baja@example.com")).patients).toEqual([]);
  });

  describe("límite de búsquedas", () => {
    it("la búsqueda 31 en una hora de la misma persona se rechaza con espera; las anteriores no", async () => {
      const { ctx } = await doctorCtx();
      for (let index = 0; index < 30; index += 1) {
        await lookupPatientsByEmail(ctx, deps, `nadie${index}@example.com`);
      }
      const error = await lookupPatientsByEmail(ctx, deps, "otra@example.com").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TooManyAttemptsError);
      expect((error as TooManyAttemptsError).retryAfterMs).toBeGreaterThan(0);
      expect((error as TooManyAttemptsError).retryAfterMs).toBeLessThanOrEqual(3_600_000);
      // La búsqueda rechazada por límite no se registra (no alarga la ventana).
      expect(await lookupRows()).toHaveLength(30);
    });

    it("pasada la hora vuelve a permitirse", async () => {
      const { ctx } = await doctorCtx();
      for (let index = 0; index < 30; index += 1) await lookupPatientsByEmail(ctx, deps, `nadie${index}@example.com`);
      clock.advance(3_600_000 + 1000);
      await expect(lookupPatientsByEmail(ctx, deps, "otra@example.com")).resolves.toEqual({ patients: [] });
    });

    it("la búsqueda 61 del mismo médico se rechaza aunque la hagan personas distintas", async () => {
      const { ctx, doctorId, userId } = await doctorCtx();
      const people: TenantContext[] = [ctx];
      for (let index = 0; index < 2; index += 1) {
        const person = await createUser(pool, { role: "reception" });
        await createMembership(pool, doctorId, person.id);
        people.push(createTenantContext(doctorId, { kind: "reception", userId: person.id }));
      }
      // 20 + 20 + 20 = 60 búsquedas, ninguna persona llega a su límite de 30.
      for (const person of people) {
        for (let index = 0; index < 20; index += 1) await lookupPatientsByEmail(person, deps, `x${person.actor.userId}-${index}@example.com`);
      }
      const last = people[1] ?? ctx;
      await expect(lookupPatientsByEmail(last, deps, "una-mas@example.com")).rejects.toBeInstanceOf(TooManyAttemptsError);
      expect(userId).toBeGreaterThan(0);
    });

    it("una ráfaga de 45 búsquedas simultáneas de la misma persona deja pasar exactamente 30", async () => {
      const { ctx } = await doctorCtx();
      const results = await Promise.allSettled(Array.from({ length: 45 }, (_unused, index) => lookupPatientsByEmail(ctx, deps, `rafaga${index}@example.com`)));
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(30);
      const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      expect(rejected).toHaveLength(15);
      expect(rejected.every((result) => result.reason instanceof TooManyAttemptsError)).toBe(true);
      expect(await lookupRows()).toHaveLength(30);
    });

    it("el límite por persona cuenta las búsquedas con TODOS sus médicos (no se multiplica por consultorio)", async () => {
      const a = await doctorCtx();
      const b = await doctorCtx();
      const person = await createUser(pool, { role: "reception" });
      await createMembership(pool, a.doctorId, person.id);
      await createMembership(pool, b.doctorId, person.id);
      const withA = createTenantContext(a.doctorId, { kind: "reception", userId: person.id });
      const withB = createTenantContext(b.doctorId, { kind: "reception", userId: person.id });
      for (let index = 0; index < 30; index += 1) await lookupPatientsByEmail(withA, deps, `nadie${index}@example.com`);
      await expect(lookupPatientsByEmail(withB, deps, "otra@example.com")).rejects.toBeInstanceOf(TooManyAttemptsError);
      // El límite por médico sigue siendo independiente: otra persona del consultorio B puede buscar.
      await expect(lookupPatientsByEmail(b.ctx, deps, "otra@example.com")).resolves.toEqual({ patients: [] });
    });

    it("el límite de un médico no afecta a otro", async () => {
      const a = await doctorCtx();
      const b = await doctorCtx();
      for (let index = 0; index < 30; index += 1) await lookupPatientsByEmail(a.ctx, deps, `nadie${index}@example.com`);
      await expect(lookupPatientsByEmail(b.ctx, deps, "hola@example.com")).resolves.toEqual({ patients: [] });
    });
  });
});

describe("boletos firmados", () => {
  it("válido para el mismo médico, actor y paciente dentro de los 15 minutos", async () => {
    const { ctx } = await doctorCtx();
    const ticket = issueTicket(SECRET, ctx, 77, clock.now());
    expect(verifyTicket(SECRET, ctx, 77, ticket, clock.now())).toBe(true);
    expect(verifyTicket(SECRET, ctx, 77, ticket, new Date(clock.now().getTime() + 14 * 60_000))).toBe(true);
  });

  it("vence a los 15 minutos", async () => {
    const { ctx } = await doctorCtx();
    const ticket = issueTicket(SECRET, ctx, 77, clock.now());
    expect(verifyTicket(SECRET, ctx, 77, ticket, new Date(clock.now().getTime() + 15 * 60_000 + 1))).toBe(false);
  });

  it("no sirve para otro paciente, otro médico ni otro actor", async () => {
    const a = await doctorCtx();
    const b = await doctorCtx();
    const ticket = issueTicket(SECRET, a.ctx, 77, clock.now());
    expect(verifyTicket(SECRET, a.ctx, 78, ticket, clock.now())).toBe(false);
    expect(verifyTicket(SECRET, b.ctx, 77, ticket, clock.now())).toBe(false);
    const reception = await createUser(pool, { role: "reception" });
    await createMembership(pool, a.doctorId, reception.id);
    const receptionCtx = createTenantContext(a.doctorId, { kind: "reception", userId: reception.id });
    expect(verifyTicket(SECRET, receptionCtx, 77, ticket, clock.now())).toBe(false);
  });

  it("no sirve alterado, con otro secreto, vacío o mal formado", async () => {
    const { ctx } = await doctorCtx();
    const ticket = issueTicket(SECRET, ctx, 77, clock.now());
    const [expires, mac] = ticket.split(".");
    expect(verifyTicket(SECRET, ctx, 77, `${Number(expires) + 60_000}.${mac}`, clock.now())).toBe(false); // alarga la caducidad
    expect(verifyTicket(SECRET, ctx, 77, `${expires}.${(mac ?? "").slice(0, -2)}AA`, clock.now())).toBe(false);
    expect(verifyTicket("otro-secreto-".repeat(4), ctx, 77, ticket, clock.now())).toBe(false);
    for (const bad of ["", "abc", "1.2.3", ".", `${expires}.`, "x.y"]) {
      expect(verifyTicket(SECRET, ctx, 77, bad, clock.now())).toBe(false);
    }
  });
});
