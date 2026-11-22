import { Writable } from "node:stream";
import { generate } from "otplib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  JPEG,
  anonymousForm,
  clientForCookie,
  createTestApp,
  linkTokenSentTo,
  loginRequest,
  postForm,
  postMultipart,
  sessionFor,
  type TestApp,
} from "./helpers/app.js";
import { clearTables, createDoctor, createPatient, createTestPool, linkPatientToDoctor, resetDatabase } from "./helpers/db.js";

const pool = createTestPool();
let t: TestApp;
let captured = "";

// Datos "reconocibles": si alguno aparece en el registro técnico, la prueba falla.
const SECRETS = {
  password: "contraseña-muy-secreta-2026",
  newPassword: "otra-contraseña-secreta-2027",
  email: "persona.reconocible@example.com",
  newEmail: "nuevo.reconocible@example.com",
  name: "Nombre Muy Reconocible",
  phone: "5598765432",
  cedula: "7654321",
};

beforeAll(async () => {
  await resetDatabase(pool);
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      captured += String(chunk);
      callback();
    },
  });
  t = await createTestApp(pool, { APP_ENV: "production", SMTP_HOST: "smtp.example.com", SMTP_PORT: "587", SMTP_USER: "u", SMTP_PASS: "p", SMTP_FROM: "n@example.com" }, { logStream: stream });
});

beforeEach(async () => {
  await clearTables(pool);
  captured = "";
  for (const type of ["patient_privacy", "doctor_privacy", "terms_doctor", "reception_privacy", "reception_confidentiality"] as const) {
    await t.services.legal.publish({ type, title: type, body: "x", isProvisional: false });
  }
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

function assertNothingSensitiveLogged(extra: string[] = []): void {
  expect(captured.length).toBeGreaterThan(0); // sí hay registro técnico
  for (const value of [...Object.values(SECRETS), ...extra]) {
    expect(captured, `el registro contiene "${value}"`).not.toContain(value);
  }
  // Nada de cabeceras de sesión ni cookies, y los tokens en rutas se registran como plantilla.
  expect(captured).not.toMatch(/__Host-(sid|csrf|did)/);
  expect(captured).not.toMatch(/set-cookie/i);
  expect(captured).not.toMatch(/\/recuperar\/[A-Za-z0-9_-]{43}/);
  expect(captured).not.toMatch(/\/cuenta\/correo\/confirmar\/[A-Za-z0-9_-]{43}/);
  expect(captured).not.toMatch(/\/recepcion\/invitacion\/[A-Za-z0-9_-]{43}/);
}

describe("el registro técnico no contiene datos personales ni secretos", () => {
  it("registro de paciente, inicio de sesión correcto y fallido, y recuperación de contraseña", async () => {
    const form = await anonymousForm(t.app, "/pacientes/registro");
    await postForm(
      t.app,
      "/pacientes/registro",
      { fullName: SECRETS.name, birthDate: "1990-05-17", email: SECRETS.email, phone: SECRETS.phone, password: SECRETS.password, acceptPrivacy: "yes", _csrf: form.token },
      form.cookie,
    );
    await loginRequest(t.app, SECRETS.email, "contraseña-incorrecta-xyz-123");
    t.clock.advance(5000);
    await loginRequest(t.app, SECRETS.email, SECRETS.password);

    const reset = await anonymousForm(t.app, "/recuperar");
    await postForm(t.app, "/recuperar", { email: SECRETS.email, _csrf: reset.token }, reset.cookie);
    const token = await linkTokenSentTo(t, SECRETS.email, "/recuperar");
    const open = await anonymousForm(t.app, `/recuperar/${token}`);
    await postForm(t.app, `/recuperar/${token}`, { password: SECRETS.newPassword, passwordConfirm: SECRETS.newPassword, _csrf: open.token }, open.cookie);

    assertNothingSensitiveLogged([token, "contraseña-incorrecta-xyz-123"]);
  });

  it("registro de médico con cédula, errores de validación y duplicados", async () => {
    const send = async (email: string) => {
      const form = await anonymousForm(t.app, "/medicos/registro");
      return postMultipart(
        t.app,
        "/medicos/registro",
        { fullName: SECRETS.name, email, password: SECRETS.password, cedulaNumber: SECRETS.cedula, emergencyMobile: SECRETS.phone, acceptPrivacy: "yes", acceptTerms: "yes", _csrf: form.token },
        [{ field: "cedulaFile", filename: "cedula-privada.jpg", content: JPEG, contentType: "image/jpeg" }],
        form.cookie,
      );
    };
    await send(SECRETS.email);
    await send(SECRETS.newEmail); // cédula y móvil duplicados
    await send("no-es-un-correo");
    assertNothingSensitiveLogged(["cedula-privada"]);
  });

  it("cambios sensibles de cuenta (contraseña y correo) y verificación del correo nuevo", async () => {
    const patient = await createPatient(pool, { email: SECRETS.email, fullName: SECRETS.name });
    const client = await sessionFor(t.services, patient.user);
    await postForm(t.app, "/cuenta/correo", { currentPassword: patient.user.password, newEmail: SECRETS.newEmail, _csrf: client.csrf }, client.cookie);
    const token = await linkTokenSentTo(t, SECRETS.newEmail, "/cuenta/correo/confirmar");
    const form = await anonymousForm(t.app, `/cuenta/correo/confirmar/${token}`);
    await postForm(t.app, `/cuenta/correo/confirmar/${token}`, { _csrf: form.token }, form.cookie);

    const second = await sessionFor(t.services, { ...patient.user, email: SECRETS.newEmail });
    await postForm(t.app, "/cuenta/contrasena", { currentPassword: "contraseña-incorrecta-xyz-123", newPassword: SECRETS.newPassword, newPasswordConfirm: SECRETS.newPassword, _csrf: second.csrf }, second.cookie);

    assertNothingSensitiveLogged([token, patient.user.password, "contraseña-incorrecta-xyz-123"]);
  });

  it("doble factor: alta, código incorrecto y uso de un código de recuperación", async () => {
    const doctor = await createDoctor(pool, { email: SECRETS.email });
    const client = await sessionFor(t.services, doctor.user);
    const start = await postForm(t.app, "/cuenta/mfa/activar", { currentPassword: doctor.user.password, _csrf: client.csrf }, client.cookie);
    const secret = /<code id="mfa-secret">([A-Z2-7]+)<\/code>/.exec(start.body)?.[1] ?? "";
    const confirm = await postForm(t.app, "/cuenta/mfa/confirmar", { code: await generate({ secret, epoch: t.clock.now().getTime() / 1000 }), _csrf: client.csrf }, client.cookie);
    const recovery = /<code class="recovery-code">([a-z0-9-]+)<\/code>/.exec(confirm.body)?.[1] ?? "";

    t.clock.advance(60_000);
    const login = await loginRequest(t.app, SECRETS.email, doctor.user.password);
    const cookie = `__Host-sid=${login.cookies.find((c) => c.name === "__Host-sid")?.value}`;
    const mfa = await clientForCookie(t.services, cookie);
    await postForm(t.app, "/login/mfa", { code: "000000", _csrf: mfa.csrf }, cookie);
    t.clock.advance(5000);
    await postForm(t.app, "/login/mfa", { code: recovery, _csrf: mfa.csrf }, cookie);

    assertNothingSensitiveLogged([secret, recovery, doctor.user.password]);
  });

  it("recepción y detalle de paciente: invitación, aceptación y consulta", async () => {
    const doctor = await createDoctor(pool, { fullName: SECRETS.name, email: "medico.privado@example.com" });
    const patient = await createPatient(pool, { fullName: SECRETS.name, email: SECRETS.newEmail });
    await linkPatientToDoctor(pool, doctor.doctorId, patient.patientId);

    await t.services.invitations.invite(doctor.doctorId, doctor.user.id, SECRETS.email);
    const token = await linkTokenSentTo(t, SECRETS.email, "/recepcion/invitacion");
    const form = await anonymousForm(t.app, `/recepcion/invitacion/${token}`);
    await postForm(t.app, `/recepcion/invitacion/${token}`, { fullName: SECRETS.name, password: SECRETS.password, acceptPrivacy: "yes", acceptConfidentiality: "yes", _csrf: form.token }, form.cookie);

    const doctorClient = await sessionFor(t.services, doctor.user);
    await t.app.inject({ method: "GET", url: `/agenda/pacientes/${patient.patientId}`, headers: { cookie: doctorClient.cookie, accept: "application/json" } });
    await t.app.inject({ method: "GET", url: "/agenda/pacientes/999999", headers: { cookie: doctorClient.cookie, accept: "application/json" } });

    assertNothingSensitiveLogged([token, "medico.privado@example.com"]);
  });
});
