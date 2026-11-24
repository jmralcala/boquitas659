import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ValidationError } from "../../src/http/errors.js";
import { clearTables, createDoctor, createPatient, createTestPool, createUser, DEFAULT_TEST_PASSWORD, resetDatabase } from "./helpers/db.js";
import { createTestApp, type TestApp } from "./helpers/app.js";

const pool = createTestPool();
let t: TestApp;
let ipCounter = 0;
const nextIp = (): string => `10.77.${(ipCounter >> 8) & 255}.${(++ipCounter) & 255}`;

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  for (const type of ["patient_privacy", "doctor_privacy", "terms_doctor", "reception_privacy", "reception_confidentiality"] as const) {
    await t.services.legal.publish({ type, title: type, body: "texto", isProvisional: false });
  }
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

const base = { deviceCookie: undefined, currentSessionToken: null };

describe("signIn (Ya soy paciente)", () => {
  it("con la contraseña correcta abre una sesión de paciente", async () => {
    const patient = await createPatient(pool, { email: "ana@example.com" });
    const result = await t.services.entry.signIn({ email: "ana@example.com", password: DEFAULT_TEST_PASSWORD, ip: nextIp(), ...base });
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.role).toBe("patient");
    const session = await t.services.sessions.validate(result.sessionToken);
    expect(session?.userId).toBe(patient.user.id);
  });

  it("normaliza el correo (mayúsculas y espacios)", async () => {
    await createPatient(pool, { email: "ana@example.com" });
    const result = await t.services.entry.signIn({ email: "  ANA@Example.COM ", password: DEFAULT_TEST_PASSWORD, ip: nextIp(), ...base });
    expect(result.kind).toBe("success");
  });

  it("con la contraseña incorrecta devuelve invalid y suma a la misma espera creciente que /login", async () => {
    await createPatient(pool, { email: "ana@example.com" });
    const ip = nextIp();
    expect(await t.services.entry.signIn({ email: "ana@example.com", password: "incorrecta-123456", ip, ...base })).toEqual({ kind: "invalid" });
    // El fallo contó para la cuenta: el siguiente intento inmediato queda en espera.
    const second = await t.services.entry.signIn({ email: "ana@example.com", password: DEFAULT_TEST_PASSWORD, ip, ...base });
    expect(second.kind).toBe("throttled");
    // Y la espera es la misma para /login (misma clave de cuenta).
    const gate = await t.services.throttle.check(t.services.throttle.accountKey("ana@example.com"), nextIp());
    expect(gate.allowed).toBe(false);
  });

  it("un correo sin cuenta devuelve no_account y también cuenta como fallo", async () => {
    const ip = nextIp();
    expect(await t.services.entry.signIn({ email: "nadie@example.com", password: "lo-que-sea-123456", ip, ...base })).toEqual({ kind: "no_account" });
    const gate = await t.services.throttle.check(t.services.throttle.accountKey("nadie@example.com"), nextIp());
    expect(gate.allowed).toBe(false);
  });

  it.each(["doctor", "reception", "support"] as const)("un correo de %s se trata como inexistente (no revela el rol) y no abre sesión", async (role) => {
    await createUser(pool, { role, email: "personal@example.com" });
    const result = await t.services.entry.signIn({ email: "personal@example.com", password: DEFAULT_TEST_PASSWORD, ip: nextIp(), ...base });
    expect(result).toEqual({ kind: "no_account" });
    expect(await rows("SELECT id FROM session")).toEqual([]);
  });

  it("una cuenta de paciente desactivada devuelve invalid", async () => {
    const patient = await createPatient(pool, { email: "baja@example.com" });
    await pool.execute("UPDATE `user` SET status = 'disabled' WHERE id = ?", [patient.user.id]);
    expect(await t.services.entry.signIn({ email: "baja@example.com", password: DEFAULT_TEST_PASSWORD, ip: nextIp(), ...base })).toEqual({ kind: "invalid" });
  });

  it("descarta la sesión anterior al abrir la nueva", async () => {
    const patient = await createPatient(pool, { email: "ana@example.com" });
    const first = await t.services.sessions.create(patient.user.id);
    const result = await t.services.entry.signIn({ email: "ana@example.com", password: DEFAULT_TEST_PASSWORD, ip: nextIp(), deviceCookie: undefined, currentSessionToken: first.token });
    expect(result.kind).toBe("success");
    expect(await t.services.sessions.validate(first.token)).toBeNull();
  });

  it("avisa por correo el primer inicio desde un dispositivo nuevo", async () => {
    await createPatient(pool, { email: "ana@example.com" });
    await t.services.entry.signIn({ email: "ana@example.com", password: DEFAULT_TEST_PASSWORD, ip: nextIp(), ...base });
    expect(await rows("SELECT template, to_email FROM email_outbox")).toEqual([{ template: "new_device_login", to_email: "ana@example.com" }]);
  });

  it("no revela datos de ningún médico: el resultado no incluye información del consultorio", async () => {
    const doctor = await createDoctor(pool);
    await createPatient(pool, { email: "ana@example.com" });
    const result = await t.services.entry.signIn({ email: "ana@example.com", password: DEFAULT_TEST_PASSWORD, ip: nextIp(), ...base });
    expect(JSON.stringify(result)).not.toContain(String(doctor.doctorId + 1000));
    expect(Object.keys(result).sort()).toEqual(["deviceId", "kind", "mfaEnabled", "role", "sessionToken"]);
  });
});

describe("registerFirstAppointment (Primera cita)", () => {
  const valid = (overrides: Record<string, string> = {}): Record<string, string> => ({
    fullName: "María López Ruiz",
    birthDate: "1990-05-17",
    email: "maria@example.com",
    phone: "5598765432",
    password: "una-contraseña-segura-2026",
    acceptPrivacy: "yes",
    ...overrides,
  });

  it("crea cuenta, paciente y aceptación del aviso de privacidad vigente, y abre sesión", async () => {
    const result = await t.services.entry.registerFirstAppointment(valid(), null);
    const session = await t.services.sessions.validate(result.sessionToken);
    expect(session?.role).toBe("patient");
    expect(await rows("SELECT email FROM `user` WHERE role = 'patient'")).toEqual([{ email: "maria@example.com" }]);
    expect(await rows("SELECT full_name FROM patient")).toEqual([{ full_name: "María López Ruiz" }]);
    const acceptances = await rows("SELECT d.type, d.version FROM consent_acceptance c JOIN legal_document d ON d.id = c.legal_document_id");
    expect(acceptances).toEqual([{ type: "patient_privacy", version: 1 }]);
  });

  it("sin la casilla del aviso de privacidad se rechaza y no se crea nada", async () => {
    await expect(t.services.entry.registerFirstAppointment(valid({ acceptPrivacy: "" }), null)).rejects.toBeInstanceOf(ValidationError);
    await expect(t.services.entry.registerFirstAppointment({ ...valid(), acceptPrivacy: undefined }, null)).rejects.toBeInstanceOf(ValidationError);
    expect(await rows("SELECT id FROM `user`")).toEqual([]);
    expect(await rows("SELECT id FROM consent_acceptance")).toEqual([]);
  });

  it("un correo ya registrado da un error de validación en el campo email, sin crear nada nuevo", async () => {
    await createPatient(pool, { email: "maria@example.com" });
    const error = await t.services.entry.registerFirstAppointment(valid(), null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(Object.keys((error as ValidationError).fields ?? {})).toEqual(["email"]);
    expect(await rows("SELECT id FROM `user`")).toHaveLength(1);
  });

  it("descarta la sesión anterior y valida el resto de los campos", async () => {
    const previous = await createPatient(pool);
    const old = await t.services.sessions.create(previous.user.id);
    await t.services.entry.registerFirstAppointment(valid(), old.token);
    expect(await t.services.sessions.validate(old.token)).toBeNull();
    const bad = await t.services.entry.registerFirstAppointment(valid({ email: "otro@example.com", phone: "123", password: "corta" }), null).catch((e: unknown) => e);
    expect(Object.keys((bad as ValidationError).fields ?? {}).sort()).toEqual(["password", "phone"]);
  });
});
