import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTables, createDoctor, createPatient, createTestPool, createUser, resetDatabase } from "../integration/helpers/db.js";
import { createSupportWithMfa, createTestApp, postForm, sessionFor, type AuthedClient, type TestApp } from "../integration/helpers/app.js";

const pool = createTestPool();
let t: TestApp;

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  for (const type of ["patient_privacy", "doctor_privacy", "terms_doctor", "reception_privacy", "reception_confidentiality"] as const) {
    await t.services.legal.publish({ type, title: `Documento ${type}`, body: `Texto de ${type} versión 1.`, isProvisional: false });
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

const publishNew = (type: "patient_privacy" | "terms_doctor" | "reception_privacy") =>
  t.services.legal.publish({ type, title: `Documento ${type}`, body: `Texto de ${type} versión 2.`, isProvisional: false });

function html(url: string, client: AuthedClient) {
  return t.app.inject({ method: "GET", url, headers: { cookie: client.cookie } });
}
function json(url: string, client: AuthedClient) {
  return t.app.inject({ method: "GET", url, headers: { cookie: client.cookie, accept: "application/json" } });
}

describe("reaceptación al publicarse una versión nueva", () => {
  it("antes de publicar nada nuevo el paciente usa el producto con normalidad", async () => {
    const patient = await createPatient(pool);
    const client = await sessionFor(t.services, patient.user);
    expect((await html("/pacientes/panel", client)).statusCode).toBe(200);
  });

  it("con una versión nueva, las rutas autenticadas se bloquean: 303 a /legal/aceptar (HTML) o 403 (JSON)", async () => {
    const patient = await createPatient(pool);
    const client = await sessionFor(t.services, patient.user);
    await publishNew("patient_privacy");

    const browser = await html("/pacientes/panel", client);
    expect(browser.statusCode).toBe(303);
    expect(browser.headers.location).toBe("/legal/aceptar");

    const api = await json("/pacientes/panel", client);
    expect(api.statusCode).toBe(403);
    expect(api.json().error).toBe("legal_acceptance_required");

    // También se bloquean las acciones que cambian estado.
    const post = await postForm(t.app, "/pacientes/adicionales", { fullName: "Menor", birthDate: "2018-01-01", acceptPrivacyOnBehalf: "yes", _csrf: client.csrf }, client.cookie);
    expect(post.statusCode).toBe(303);
    expect(post.headers.location).toBe("/legal/aceptar");
    expect(await rows("SELECT COUNT(*) AS n FROM patient WHERE is_minor_dependent = 1")).toEqual([{ n: 0 }]);
  });

  it("la pantalla de aceptación lista el documento pendiente con su casilla sin marcar", async () => {
    const client = await sessionFor(t.services, (await createPatient(pool)).user);
    await publishNew("patient_privacy");
    const response = await html("/legal/aceptar", client);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Documento patient_privacy");
    expect(response.body).toContain("/legal/patient_privacy");
    expect(response.body).toMatch(/name="accept_\d+"/);
    expect(response.body).not.toMatch(/\bchecked\b/);
  });

  it("sin marcar la casilla sigue bloqueado y no se registra nada", async () => {
    const patient = await createPatient(pool);
    const client = await sessionFor(t.services, patient.user);
    await publishNew("patient_privacy");
    const before = await rows("SELECT COUNT(*) AS n FROM consent_acceptance");

    const response = await postForm(t.app, "/legal/aceptar", { _csrf: client.csrf }, client.cookie);
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("aviso");
    expect(await rows("SELECT COUNT(*) AS n FROM consent_acceptance")).toEqual(before);
    expect((await html("/pacientes/panel", client)).statusCode).toBe(303);
  });

  it("al aceptar se registra (quién, documento, versión, cuándo) y se libera el acceso", async () => {
    const patient = await createPatient(pool);
    const client = await sessionFor(t.services, patient.user);
    const v2 = await publishNew("patient_privacy");

    const response = await postForm(t.app, "/legal/aceptar", { [`accept_${v2.id}`]: "yes", _csrf: client.csrf }, client.cookie);
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/pacientes/panel");

    const accepted = await rows(
      `SELECT c.user_id, d.type, d.version, c.accepted_at, c.on_behalf_of_patient_id FROM consent_acceptance c
         JOIN legal_document d ON d.id = c.legal_document_id WHERE d.version = 2`,
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ user_id: patient.user.id, type: "patient_privacy", version: 2, on_behalf_of_patient_id: null });
    expect(accepted[0]?.accepted_at).toBeInstanceOf(Date);
    expect((await html("/pacientes/panel", client)).statusCode).toBe(200);
  });

  it("solo exige los documentos que aplican al rol", async () => {
    const patient = await createPatient(pool);
    const doctor = await createDoctor(pool);
    const patientClient = await sessionFor(t.services, patient.user);
    const doctorClient = await sessionFor(t.services, doctor.user);

    await publishNew("terms_doctor"); // solo aplica a médicos
    expect((await html("/pacientes/panel", patientClient)).statusCode).toBe(200);
    expect((await html("/medicos/panel", doctorClient)).statusCode).toBe(303);

    await publishNew("reception_privacy"); // solo aplica a recepción
    expect((await html("/medicos/panel", doctorClient)).statusCode).toBe(303);
  });

  it("no se puede aceptar un documento que no está pendiente para el rol ni inventar identificadores", async () => {
    const patient = await createPatient(pool);
    const client = await sessionFor(t.services, patient.user);
    const termsDoctor = await publishNew("terms_doctor");
    const before = await rows("SELECT COUNT(*) AS n FROM consent_acceptance");
    const response = await postForm(t.app, "/legal/aceptar", { [`accept_${termsDoctor.id}`]: "yes", accept_99999: "yes", _csrf: client.csrf }, client.cookie);
    // No hay nada pendiente para este paciente: no se registra nada y se le lleva a su panel.
    expect(response.statusCode).toBe(303);
    expect(await rows("SELECT COUNT(*) AS n FROM consent_acceptance")).toEqual(before);
  });

  it("un usuario que nunca aceptó el aviso vigente también queda bloqueado", async () => {
    const user = await createUser(pool, { role: "patient", acceptLegal: false });
    await pool.execute("INSERT INTO patient_account (user_id, phone) VALUES (?, '5512345678')", [user.id]);
    const client = await sessionFor(t.services, user);
    expect((await html("/pacientes/panel", client)).statusCode).toBe(303);
  });

  it("soporte nunca queda bloqueado (no tiene documentos aplicables)", async () => {
    const support = await createSupportWithMfa(t, pool);
    const client = await sessionFor(t.services, support);
    await publishNew("patient_privacy");
    await publishNew("terms_doctor");
    expect((await json("/soporte/medicos", client)).statusCode).toBe(200);
  });

  it("las rutas públicas y el cierre de sesión siguen disponibles para quien debe aceptar", async () => {
    const client = await sessionFor(t.services, (await createPatient(pool)).user);
    await publishNew("patient_privacy");
    for (const url of ["/legal", "/legal/patient_privacy", "/derechos", "/legal/aceptar"]) {
      expect((await html(url, client)).statusCode, url).toBe(200);
    }
    const logout = await postForm(t.app, "/logout", { _csrf: client.csrf }, client.cookie);
    expect(logout.statusCode).toBe(303);
    expect(logout.headers.location).toBe("/login");
  });

  it("sin sesión, las rutas públicas no se ven afectadas", async () => {
    await publishNew("patient_privacy");
    expect((await t.app.inject({ method: "GET", url: "/login" })).statusCode).toBe(200);
    expect((await t.app.inject({ method: "GET", url: "/pacientes/registro" })).statusCode).toBe(200);
  });

  it("el registro de aceptaciones es de solo anexar: una versión nueva no borra las anteriores", async () => {
    const patient = await createPatient(pool);
    const client = await sessionFor(t.services, patient.user);
    const v2 = await publishNew("patient_privacy");
    await postForm(t.app, "/legal/aceptar", { [`accept_${v2.id}`]: "yes", _csrf: client.csrf }, client.cookie);
    expect(await rows("SELECT COUNT(*) AS n FROM consent_acceptance WHERE user_id = ?", [patient.user.id])).toEqual([{ n: 2 }]);
  });

  it("exige token CSRF", async () => {
    const client = await sessionFor(t.services, (await createPatient(pool)).user);
    const v2 = await publishNew("patient_privacy");
    const response = await postForm(t.app, "/legal/aceptar", { [`accept_${v2.id}`]: "yes" }, client.cookie);
    expect(response.statusCode).toBe(403);
  });
});
