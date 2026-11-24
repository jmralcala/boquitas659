import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictError } from "../../src/http/errors.js";
import { hasActiveMembership, listDoctorsForReception } from "../../src/modules/reception/reception-repository.js";
import {
  clearTables,
  createDoctor,
  createPublishedSite,
  createTestPool,
  createUser,
  ensurePrivacyDocument,
  resetDatabase,
  setAccountState,
  type CreatedDoctor,
} from "./helpers/db.js";
import { agendaClientFor, createTestApp, loginRequest, sessionFor, uniqueIp, type TestApp } from "./helpers/app.js";

const pool = createTestPool();
let t: TestApp;
let supportId: number;

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
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

const change = (doctor: CreatedDoctor, action: "suspend" | "setReadOnly" | "reactivate", from: "active" | "suspended" | "read_only", reason = "motivo interno") =>
  t.services.accountState[action]({ doctorId: doctor.doctorId, supportUserId: supportId, reason, from });

const stateOf = async (doctor: CreatedDoctor) => (await rows("SELECT account_state FROM doctor WHERE id = ?", [doctor.doctorId]))[0]?.account_state;
const log = () => rows("SELECT action, target_id, reason, support_user_id FROM support_action_log ORDER BY id");

describe("suspender una cuenta", () => {
  it("cierra el acceso del médico, sus sesiones y deja aviso fijo e historial", async () => {
    const doctor = await createDoctor(pool);
    await createPublishedSite(pool, doctor, { slug: "clinica-rios" });
    const session = await sessionFor(t.services, doctor.user);
    expect(await t.services.sessions.validate(session.cookie.split("=")[1] ?? "")).not.toBeNull();

    await change(doctor, "suspend", "active", "cuenta duplicada");

    expect(await stateOf(doctor)).toBe("suspended");
    const [state] = await rows("SELECT account_state_changed_by AS by_user, account_state_changed_at AS at FROM doctor WHERE id = ?", [doctor.doctorId]);
    expect(state?.by_user).toBe(supportId);
    expect(state?.at).toBeInstanceOf(Date);
    expect((await rows("SELECT status FROM `user` WHERE id = ?", [doctor.user.id]))[0]?.status).toBe("disabled");
    expect(await t.services.sessions.validate(session.cookie.split("=")[1] ?? "")).toBeNull();

    // Con la contraseña correcta el inicio de sesión se rechaza igual que uno inválido: sin sesión nueva.
    const login = await loginRequest(t.app, doctor.user.email, doctor.user.password, { ip: uniqueIp() });
    expect(login.statusCode).toBeGreaterThanOrEqual(400);
    expect(login.cookies.find((cookie) => cookie.name === "__Host-session")).toBeUndefined();

    expect(await log()).toEqual([{ action: "suspend", target_id: doctor.doctorId, reason: "cuenta duplicada", support_user_id: supportId }]);
    const mail = await rows("SELECT template, to_email, payload_ref FROM email_outbox WHERE template = 'doctor_account_suspended'");
    expect(mail).toHaveLength(1);
    expect(mail[0]?.to_email).toBe(doctor.user.email);
    expect(String(mail[0]?.payload_ref)).not.toContain("cuenta duplicada");
  });

  it("su recepción ya no lo ve en el selector ni entra al consultorio", async () => {
    const doctor = await createDoctor(pool);
    const reception = await agendaClientFor(t, pool, "reception", { doctor });
    expect((await t.app.inject({ method: "GET", url: "/agenda/dia/2026-06-16", remoteAddress: uniqueIp(), headers: { cookie: reception.client.cookie, accept: "application/json" } })).statusCode).toBe(200);

    await change(doctor, "suspend", "active");

    const agenda = await t.app.inject({ method: "GET", url: "/agenda/dia/2026-06-16", remoteAddress: uniqueIp(), headers: { cookie: reception.client.cookie, accept: "application/json" } });
    expect(agenda.statusCode).toBe(403);
    expect(await listDoctorsForReception(pool, reception.user.id)).toEqual([]);
    expect(await hasActiveMembership(pool, reception.user.id, doctor.doctorId)).toBe(false);
  });

  it("el micrositio deja de aceptar reservas y pide confirmar por teléfono", async () => {
    const doctor = await createDoctor(pool);
    await createPublishedSite(pool, doctor, { slug: "clinica-rios" });
    const before = await t.app.inject({ method: "GET", url: "/c/clinica-rios", remoteAddress: uniqueIp() });
    expect(before.body).not.toContain("no está recibiendo reservas");
    await change(doctor, "suspend", "active");
    const after = await t.app.inject({ method: "GET", url: "/c/clinica-rios", remoteAddress: uniqueIp() });
    expect(after.body).toContain("no está recibiendo reservas");
  });

  it("reactivar devuelve el acceso, rehabilita al usuario y avisa; el micrositio vuelve a su estado", async () => {
    const doctor = await createDoctor(pool);
    await createPublishedSite(pool, doctor, { slug: "clinica-rios" });
    await change(doctor, "suspend", "active");
    await change(doctor, "reactivate", "suspended", "ya se aclaró");

    expect(await stateOf(doctor)).toBe("active");
    expect((await rows("SELECT status FROM `user` WHERE id = ?", [doctor.user.id]))[0]?.status).toBe("active");
    const login = await loginRequest(t.app, doctor.user.email, doctor.user.password, { ip: uniqueIp() });
    expect(login.statusCode).toBeLessThan(400);
    expect((await t.app.inject({ method: "GET", url: "/c/clinica-rios", remoteAddress: uniqueIp() })).body).not.toContain("no está recibiendo reservas");
    expect((await log()).map((entry) => entry.action)).toEqual(["suspend", "reactivate"]);
    expect(await rows("SELECT 1 FROM email_outbox WHERE template = 'doctor_account_reactivated'")).toHaveLength(1);
  });
});

describe("solo lectura", () => {
  it("pone la cuenta en solo lectura, avisa al médico y no deshabilita al usuario", async () => {
    const doctor = await createDoctor(pool);
    await change(doctor, "setReadOnly", "active");
    expect(await stateOf(doctor)).toBe("read_only");
    expect((await rows("SELECT status FROM `user` WHERE id = ?", [doctor.user.id]))[0]?.status).toBe("active");
    expect(await rows("SELECT 1 FROM email_outbox WHERE template = 'doctor_account_read_only'")).toHaveLength(1);
    expect((await log())[0]?.action).toBe("read_only");
  });

  it("de solo lectura se puede suspender, y suspender cierra las sesiones", async () => {
    const doctor = await createDoctor(pool);
    const session = await sessionFor(t.services, doctor.user);
    await change(doctor, "setReadOnly", "active");
    await change(doctor, "suspend", "read_only");
    expect(await stateOf(doctor)).toBe("suspended");
    expect(await t.services.sessions.validate(session.cookie.split("=")[1] ?? "")).toBeNull();
  });
});

describe("transiciones inválidas y estado desactualizado", () => {
  it("reactivar a quien está activo, o suspender a quien ya está suspendido, es 409 sin cambios ni historial", async () => {
    const doctor = await createDoctor(pool);
    await expect(change(doctor, "reactivate", "active")).rejects.toBeInstanceOf(ConflictError);
    await change(doctor, "suspend", "active");
    await expect(change(doctor, "suspend", "suspended")).rejects.toBeInstanceOf(ConflictError);
    expect(await log()).toHaveLength(1);
    expect(await rows("SELECT 1 FROM email_outbox WHERE template = 'doctor_account_suspended'")).toHaveLength(1);
  });

  it("un `from` obsoleto es 409 aunque la transición sería válida", async () => {
    const doctor = await createDoctor(pool);
    await change(doctor, "setReadOnly", "active");
    // La persona veía «activo», pero la cuenta ya estaba en solo lectura.
    await expect(change(doctor, "suspend", "active")).rejects.toMatchObject({ code: "state_changed" });
    expect(await stateOf(doctor)).toBe("read_only");
    expect(await log()).toHaveLength(1);
  });

  it("un médico pendiente o rechazado no tiene estado operativo que cambiar (409)", async () => {
    for (const status of ["pending", "rejected"] as const) {
      const doctor = await createDoctor(pool, { status });
      await expect(change(doctor, "suspend", "active")).rejects.toBeInstanceOf(ConflictError);
      expect(await stateOf(doctor)).toBe("active");
    }
    expect(await log()).toEqual([]);
  });

  it("un médico que no existe es 404 y una cuenta de soporte no es un médico", async () => {
    await expect(t.services.accountState.suspend({ doctorId: 999999, supportUserId: supportId, reason: "x", from: "active" })).rejects.toMatchObject({ status: 404 });
    await expect(t.services.accountState.suspend({ doctorId: supportId, supportUserId: supportId, reason: "x", from: "active" })).rejects.toMatchObject({ status: 404 });
  });
});

describe("aprobar no cambia el estado operativo (FR-011)", () => {
  it("aprobar deja la cuenta activa y el tiempo de prueba no la pasa a solo lectura ni la suspende", async () => {
    const doctor = await createDoctor(pool, { status: "pending" });
    await t.services.support.approve(doctor.doctorId, supportId);
    expect(await stateOf(doctor)).toBe("active");
    // Con la prueba ya vencida, la cuenta sigue activa: nada cambia por el paso del tiempo.
    await pool.execute("UPDATE doctor SET trial_ends_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 30 DAY) WHERE id = ?", [doctor.doctorId]);
    expect(await stateOf(doctor)).toBe("active");
  });

  it("un cambio de estado previo se conserva al aprobar de nuevo tras liberar la cédula", async () => {
    const doctor = await createDoctor(pool);
    await setAccountState(pool, doctor.doctorId, "read_only");
    await t.services.support.releaseCedula(doctor.doctorId, supportId, "registrada por error");
    expect(await stateOf(doctor)).toBe("read_only");
  });
});

describe("atomicidad: si el historial falla, no queda ni el cambio ni el aviso", () => {
  it("suspender con el alta del historial fallando deja la cuenta, el usuario, las sesiones y la cola intactos", async () => {
    const doctor = await createDoctor(pool);
    const session = await sessionFor(t.services, doctor.user);
    await pool.query("CREATE TRIGGER support_log_test_fail BEFORE INSERT ON support_action_log FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'fallo de prueba'");
    try {
      await expect(change(doctor, "suspend", "active")).rejects.toThrow();
    } finally {
      await pool.query("DROP TRIGGER support_log_test_fail");
    }
    expect(await stateOf(doctor)).toBe("active");
    expect((await rows("SELECT status FROM `user` WHERE id = ?", [doctor.user.id]))[0]?.status).toBe("active");
    expect(await t.services.sessions.validate(session.cookie.split("=")[1] ?? "")).not.toBeNull();
    expect(await rows("SELECT id FROM email_outbox")).toEqual([]);
    expect(await log()).toEqual([]);
  });

  it("liberar la cédula de una cuenta suspendida es 409: hay que reactivarla antes", async () => {
    const doctor = await createDoctor(pool);
    await change(doctor, "suspend", "active");
    await expect(t.services.support.releaseCedula(doctor.doctorId, supportId, "x")).rejects.toBeInstanceOf(ConflictError);
    expect((await rows("SELECT cedula_number FROM doctor WHERE id = ?", [doctor.doctorId]))[0]?.cedula_number).not.toBeNull();
    await change(doctor, "reactivate", "suspended");
    await t.services.support.releaseCedula(doctor.doctorId, supportId, "registrada por error");
    expect((await rows("SELECT cedula_number FROM doctor WHERE id = ?", [doctor.doctorId]))[0]?.cedula_number).toBeNull();
  });
});
