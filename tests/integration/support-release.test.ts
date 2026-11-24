import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTables, createAppointment, createDoctor, createPatient, createPublishedSite, createTestPool, createUser, ensurePrivacyDocument, resetDatabase, setAccountState } from "./helpers/db.js";
import { createSupportWithMfa, createTestApp, postForm, sessionFor, uniqueIp, type AuthedClient, type TestApp } from "./helpers/app.js";

const pool = createTestPool();
let t: TestApp;
let support: AuthedClient;
let supportId: number;

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  t.clock.set(new Date("2026-06-15T14:00:00.000Z"));
  await ensurePrivacyDocument(pool);
  const user = await createSupportWithMfa(t, pool);
  supportId = user.id;
  support = await sessionFor(t.services, user);
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

async function clinicWithFutureAppointments() {
  const doctor = await createDoctor(pool);
  await createPublishedSite(pool, doctor, { slug: "clinica-rios" });
  const patient = await createPatient(pool, { fullName: "Paciente Reconocible Única" });
  for (const day of ["2026-06-20", "2026-06-21", "2026-06-22"]) {
    await createAppointment(pool, { doctorId: doctor.doctorId, patientId: patient.patientId, startUtc: new Date(`${day}T16:00:00.000Z`) });
  }
  await createAppointment(pool, { doctorId: doctor.doctorId, patientId: patient.patientId, startUtc: new Date("2026-06-23T16:00:00.000Z"), status: "cancelled" });
  await createAppointment(pool, { doctorId: doctor.doctorId, patientId: patient.patientId, startUtc: new Date("2026-06-01T16:00:00.000Z") }); // pasada
  return { doctor, patient };
}

const get = (url: string) => t.app.inject({ method: "GET", url, remoteAddress: uniqueIp(), headers: { cookie: support.cookie } });
const release = (doctorId: number, fields: Record<string, string> = { reason: "registrada por error", confirm: "yes" }) =>
  postForm(t.app, `/soporte/medicos/${doctorId}/liberar-cedula`, { _csrf: support.csrf, ...fields }, support.cookie);

describe("vista previa de la liberación", () => {
  it("muestra el número de citas futuras vigentes y el estado del micrositio sin cambiar nada ni mostrar pacientes", async () => {
    const { doctor } = await clinicWithFutureAppointments();
    const before = await rows("SELECT cedula_number, emergency_mobile, approval_status FROM doctor WHERE id = ?", [doctor.doctorId]);
    const response = await get(`/soporte/medicos/${doctor.doctorId}/liberar-cedula`);
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatch(/Citas futuras<\/dt><dd>3</);
    expect(response.body).toContain("Publicado");
    expect(response.body).toContain("/c/clinica-rios");
    expect(response.body).not.toContain("Paciente Reconocible Única");
    expect(response.body).toContain("No escribas datos de pacientes");
    expect(await rows("SELECT cedula_number, emergency_mobile, approval_status FROM doctor WHERE id = ?", [doctor.doctorId])).toEqual(before);
    expect(await rows("SELECT id FROM support_action_log")).toEqual([]);
  });

  it("un médico inexistente es 404", async () => {
    expect((await get("/soporte/medicos/999999/liberar-cedula")).statusCode).toBe(404);
  });
});

describe("liberar la cédula", () => {
  it("libera cédula y móvil, deja la cuenta rechazada, el micrositio sin reservas, el aviso fijo y el historial", async () => {
    const { doctor } = await clinicWithFutureAppointments();
    const response = await release(doctor.doctorId);
    expect(response.statusCode).toBe(303);

    expect((await rows("SELECT cedula_number, cedula_normalized, emergency_mobile, approval_status FROM doctor WHERE id = ?", [doctor.doctorId]))[0]).toEqual({
      cedula_number: null,
      cedula_normalized: null,
      emergency_mobile: null,
      approval_status: "rejected",
    });
    expect((await t.app.inject({ method: "GET", url: "/c/clinica-rios", remoteAddress: uniqueIp() })).body).toContain("no está recibiendo reservas");
    expect(await rows("SELECT support_user_id, action, reason FROM support_action_log")).toEqual([
      { support_user_id: supportId, action: "release_cedula", reason: "registrada por error" },
    ]);
    const mail = await rows("SELECT template, to_email FROM email_outbox");
    expect(mail).toEqual([{ template: "doctor_rejected", to_email: doctor.user.email }]);
    await t.runOutbox();
    const sent = t.transport.sent.find((message) => message.to === doctor.user.email);
    expect(sent?.text).toContain("liberó tu cédula");
    expect(sent?.text).not.toContain("registrada por error");
  });

  it("otra persona puede registrarse con la cédula liberada", async () => {
    const { doctor } = await clinicWithFutureAppointments();
    const cedula = doctor.cedula;
    await release(doctor.doctorId);
    const other = await createUser(pool, { role: "doctor" });
    await pool.execute("INSERT INTO doctor (user_id, full_name, cedula_number, cedula_normalized, emergency_mobile, approval_status) VALUES (?, 'Otra Persona', ?, ?, '5511112222', 'pending')", [other.id, cedula, cedula]);
    expect((await rows("SELECT id FROM doctor WHERE cedula_normalized = ?", [cedula])).length).toBe(1);
  });

  it("no cambia el estado operativo de la cuenta (lo conserva al volver a aprobarse)", async () => {
    const { doctor } = await clinicWithFutureAppointments();
    await setAccountState(pool, doctor.doctorId, "read_only");
    await release(doctor.doctorId);
    expect((await rows("SELECT account_state FROM doctor WHERE id = ?", [doctor.doctorId]))[0]?.account_state).toBe("read_only");
  });

  it("sin motivo o sin confirmar es 400 y no cambia nada", async () => {
    const { doctor } = await clinicWithFutureAppointments();
    for (const fields of [{ confirm: "yes" }, { reason: "  ", confirm: "yes" }, { reason: "x" }, { reason: "x", confirm: "no" }] as Array<Record<string, string>>) {
      expect((await release(doctor.doctorId, fields)).statusCode, JSON.stringify(fields)).toBe(400);
    }
    expect((await rows("SELECT approval_status, cedula_number FROM doctor WHERE id = ?", [doctor.doctorId]))[0]?.approval_status).toBe("approved");
    expect(await rows("SELECT id FROM support_action_log")).toEqual([]);
  });

  it("el doble envío libera una sola vez", async () => {
    const { doctor } = await clinicWithFutureAppointments();
    const results = await Promise.all([release(doctor.doctorId), release(doctor.doctorId)]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([303, 303]);
    expect(await rows("SELECT id FROM support_action_log")).toHaveLength(1);
    expect(await rows("SELECT id FROM email_outbox")).toHaveLength(1);
  });
});
