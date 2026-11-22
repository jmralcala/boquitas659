import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTables, createDoctor, createTestPool, createUser, resetDatabase } from "./helpers/db.js";
import { JPEG, createTestApp, type TestApp } from "./helpers/app.js";

const pool = createTestPool();
const DAY = 86_400_000;
let t: TestApp;
let supportId: number;

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  supportId = (await createUser(pool, { role: "support" })).id;
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

async function doctorRow(id: number): Promise<RowDataPacket> {
  const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM doctor WHERE id = ?", [id]);
  return rows[0] as RowDataPacket;
}

async function reviews(doctorId: number): Promise<RowDataPacket[]> {
  const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM doctor_review WHERE doctor_id = ? ORDER BY id", [
    doctorId,
  ]);
  return rows;
}

describe("aprobar", () => {
  it("pasa de pending a approved, inicia la prueba de 5 días en ese instante y avisa al médico", async () => {
    const doctor = await createDoctor(pool, { status: "pending", email: "dra@example.com" });
    t.clock.set(new Date("2026-07-01T15:00:00.000Z"));
    await t.services.support.approve(doctor.doctorId, supportId);

    const row = await doctorRow(doctor.doctorId);
    expect(row).toMatchObject({ approval_status: "approved", approved_by_user_id: supportId, rejection_reason: null });
    expect((row.approved_at as Date).toISOString()).toBe("2026-07-01T15:00:00.000Z");
    expect((row.trial_started_at as Date).toISOString()).toBe("2026-07-01T15:00:00.000Z");
    expect((row.trial_ends_at as Date).getTime()).toBe(new Date("2026-07-01T15:00:00.000Z").getTime() + 5 * DAY);

    expect(await reviews(doctor.doctorId)).toMatchObject([{ decision: "approved", decided_by_user_id: supportId }]);

    await t.runOutbox();
    const email = t.transport.sent.find((m) => m.to === "dra@example.com");
    expect(email?.subject).toMatch(/aprobad/i);
    expect(email?.text).toContain("5 días");
  });

  it("una cuenta ya aprobada no se puede aprobar ni rechazar de nuevo", async () => {
    const doctor = await createDoctor(pool, { status: "approved" });
    await expect(t.services.support.approve(doctor.doctorId, supportId)).rejects.toMatchObject({ status: 409 });
    await expect(t.services.support.reject(doctor.doctorId, supportId, "motivo")).rejects.toMatchObject({
      status: 409,
    });
    expect(await reviews(doctor.doctorId)).toHaveLength(0);
  });

  it("dos aprobaciones simultáneas: solo una prospera y queda una sola decisión", async () => {
    const doctor = await createDoctor(pool, { status: "pending" });
    const results = await Promise.allSettled([
      t.services.support.approve(doctor.doctorId, supportId),
      t.services.support.approve(doctor.doctorId, supportId),
      t.services.support.approve(doctor.doctorId, supportId),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await reviews(doctor.doctorId)).toHaveLength(1);
  });

  it("un médico inexistente da 404", async () => {
    await expect(t.services.support.approve(999999, supportId)).rejects.toMatchObject({ status: 404 });
  });
});

describe("rechazar", () => {
  it("exige un motivo, guarda la decisión y avisa al médico con el motivo", async () => {
    const doctor = await createDoctor(pool, { status: "pending", email: "dr@example.com" });
    await expect(t.services.support.reject(doctor.doctorId, supportId, "   ")).rejects.toMatchObject({ status: 400 });
    expect((await doctorRow(doctor.doctorId)).approval_status).toBe("pending");

    await t.services.support.reject(doctor.doctorId, supportId, "La foto de la cédula no se lee");
    expect(await doctorRow(doctor.doctorId)).toMatchObject({
      approval_status: "rejected",
      rejection_reason: "La foto de la cédula no se lee",
    });
    expect(await reviews(doctor.doctorId)).toMatchObject([
      { decision: "rejected", reason: "La foto de la cédula no se lee" },
    ]);

    await t.runOutbox();
    const email = t.transport.sent.find((m) => m.to === "dr@example.com");
    expect(email?.text).toContain("La foto de la cédula no se lee");
    expect(email?.text).toContain("/medicos/estado");
  });
});

describe("reenviar la solicitud (rejected → pending)", () => {
  it("el médico rechazado corrige y reenvía sin crear otra cuenta, y soporte es avisado", async () => {
    const doctor = await createDoctor(pool, { status: "rejected" });
    await t.services.doctors.resubmit(doctor.user.id, { cedulaNumber: "7654321", cedulaFile: JPEG });
    const row = await doctorRow(doctor.doctorId);
    expect(row).toMatchObject({ approval_status: "pending", rejection_reason: null, cedula_normalized: "7654321" });
    expect(row.cedula_file_path).toMatch(/^[a-f0-9]{32}\.jpg$/);

    await t.runOutbox();
    expect(t.transport.sent.some((m) => m.to === "soporte@innvend.com")).toBe(true);
    const [users] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM `user`");
    expect(Number(users[0]?.n)).toBe(2); // soporte + médico
  });

  it("solo se puede reenviar una solicitud rechazada", async () => {
    const pending = await createDoctor(pool, { status: "pending" });
    const approved = await createDoctor(pool, { status: "approved" });
    await expect(t.services.doctors.resubmit(pending.user.id, {})).rejects.toMatchObject({ status: 409 });
    await expect(t.services.doctors.resubmit(approved.user.id, {})).rejects.toMatchObject({ status: 409 });
  });

  it("no permite reenviar con una cédula que ya usa otra cuenta", async () => {
    const other = await createDoctor(pool, { status: "approved" });
    const doctor = await createDoctor(pool, { status: "rejected" });
    await expect(
      t.services.doctors.resubmit(doctor.user.id, { cedulaNumber: other.cedula, cedulaFile: JPEG }),
    ).rejects.toMatchObject({ status: 400 });
    expect((await doctorRow(doctor.doctorId)).approval_status).toBe("rejected");
  });
});

describe("liberar cédula y móvil", () => {
  it("pone NULL en cédula y móvil, deja la cuenta rechazada y permite reutilizarlos", async () => {
    const doctor = await createDoctor(pool, { status: "pending" });
    await expect(t.services.support.releaseCedula(doctor.doctorId, supportId, "")).rejects.toMatchObject({
      status: 400,
    });

    await t.services.support.releaseCedula(doctor.doctorId, supportId, "Registrada por otra persona");
    expect(await doctorRow(doctor.doctorId)).toMatchObject({
      cedula_number: null,
      cedula_normalized: null,
      emergency_mobile: null,
      approval_status: "rejected",
    });
    expect(await reviews(doctor.doctorId)).toMatchObject([
      { decision: "cedula_released", reason: "Registrada por otra persona" },
    ]);

    // Otro médico ya puede usar esa cédula y ese móvil.
    const other = await createDoctor(pool, { status: "rejected" });
    await t.services.doctors.resubmit(other.user.id, {
      cedulaNumber: doctor.cedula,
      emergencyMobile: doctor.mobile,
      cedulaFile: JPEG,
    });
    expect(await doctorRow(other.doctorId)).toMatchObject({
      cedula_normalized: doctor.cedula,
      approval_status: "pending",
    });
  });

  it("tras liberar, el médico debe volver a dar cédula, archivo y móvil para reenviar", async () => {
    const doctor = await createDoctor(pool, { status: "approved" });
    await t.services.support.releaseCedula(doctor.doctorId, supportId, "Disputa de cédula");
    await expect(t.services.doctors.resubmit(doctor.user.id, {})).rejects.toMatchObject({ status: 400 });
    await t.services.doctors.resubmit(doctor.user.id, {
      cedulaNumber: "2222222",
      cedulaFile: JPEG,
      emergencyMobile: "5544332211",
    });
    expect(await doctorRow(doctor.doctorId)).toMatchObject({
      approval_status: "pending",
      emergency_mobile: "5544332211",
    });
  });
});
