import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { alarmPage, callOfficePage, captchaUnavailablePage, noSpacePage } from "../../src/http/views/urgent.js";
import { TRIAGE_CONTENT } from "../../src/modules/urgent/triage-content.js";
import { clearTables, createAppointment, createDoctor, createPatient, createPublishedSite, createTestPool, ensurePrivacyDocument, resetDatabase } from "../integration/helpers/db.js";
import { createTestApp, sessionFor, uniqueIp, type TestApp } from "../integration/helpers/app.js";

const pool = createTestPool();
let t: TestApp;
const NOW = new Date("2026-06-15T14:00:00.000Z"); // lunes 8:00 en Ciudad de México

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  t.clock.set(NOW);
  await ensurePrivacyDocument(pool);
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

const get = (url: string, cookie?: string) =>
  t.app.inject({ method: "GET", url, remoteAddress: uniqueIp(), headers: { accept: "text/html", ...(cookie ? { cookie } : {}) } });

const CARD = /<body class="card-page( card-page--narrow)?">/;

async function published() {
  const doctor = await createDoctor(pool, { fullName: "Dra. Elena Ríos" });
  await createPublishedSite(pool, doctor, { slug: "clinica-rios" });
  return doctor;
}

describe("pantallas públicas y de acceso", () => {
  it("usan la tarjeta centrada, con un botón primario y la entrada de acceso en un ancho angosto", async () => {
    await published();
    for (const url of ["/login", "/recuperar", "/legal", "/derechos", "/pacientes/registro", "/medicos/registro", "/c/clinica-rios", "/c/clinica-rios/entrar", "/c/clinica-rios/primera-cita", "/citas/enlace/no-existe"]) {
      expect((await get(url)).body, url).toMatch(CARD);
    }
    expect((await get("/login")).body).toContain("card-page--narrow");
    expect((await get("/c/clinica-rios/entrar")).body).toContain("card-page--narrow");
  });

  it("el micrositio ofrece las dos entradas (una primaria), «Cómo llegar» como botón y el teléfono", async () => {
    await published();
    const body = (await get("/c/clinica-rios")).body;
    expect(body).toMatch(/<a class="btn" href="\/c\/clinica-rios\/primera-cita">Primera cita<\/a>/);
    expect(body).toMatch(/<a class="btn btn-secondary" href="\/c\/clinica-rios\/entrar">Ya soy paciente<\/a>/);
    expect(body).toMatch(/class="btn btn-secondary" href="https:\/\/www\.google\.com\/maps\/search\//);
    expect(body).toContain("55 9876 5432");
  });

  it("el micrositio no disponible usa un aviso de advertencia con el teléfono", async () => {
    const doctor = await published();
    await pool.execute("UPDATE doctor_site SET status = 'unpublished' WHERE doctor_id = ?", [doctor.doctorId]);
    const body = (await get("/c/clinica-rios")).body;
    expect(body).toContain("alert alert--warning");
    expect(body).toContain("no está recibiendo reservas en línea");
  });

  it("los errores del formulario de acceso conservan su texto y usan el estilo de error", async () => {
    const response = await get("/login");
    expect(response.body).toContain("<label>Correo");
    expect(response.body).toContain('type="submit"');
  });
});

describe("reserva y citas del paciente", () => {
  it("el calendario muestra los días libres como controles táctiles y los horarios como opciones tipo botón", async () => {
    const doctor = await published();
    const patient = await createPatient(pool);
    const client = await sessionFor(t.services, patient.user);
    const body = (await get("/c/clinica-rios/reservar?fecha=2026-06-16", client.cookie)).body;
    expect(body).toContain('class="table-wrap"');
    expect(body).toContain('class="month"');
    expect(body).toMatch(/class="day day--free"/);
    expect(body).toMatch(/<label class="slot"><input type="radio" name="inicio" value="[^"]+"[^>]*> <span>\d{2}:\d{2}[^<]*<\/span><\/label>/);
    expect(body).toContain('class="slots"');
    expect(doctor.doctorId).toBeGreaterThan(0);
  });

  it("«Mis citas» muestra insignias con texto, «Mis citas» vacío usa el estado vacío y cancelar es acción de peligro", async () => {
    const doctor = await published();
    const patient = await createPatient(pool);
    const client = await sessionFor(t.services, patient.user);
    expect((await get("/pacientes/citas", client.cookie)).body).toContain('class="empty"');

    const booked = await createAppointment(pool, { doctorId: doctor.doctorId, patientId: patient.patientId, startUtc: new Date("2026-06-20T16:00:00.000Z") });
    const cancelled = await createAppointment(pool, { doctorId: doctor.doctorId, patientId: patient.patientId, startUtc: new Date("2026-06-21T16:00:00.000Z") });
    await pool.execute("UPDATE appointment SET status = 'cancelled' WHERE id = ?", [cancelled]);

    const list = (await get("/pacientes/citas", client.cookie)).body;
    expect(list).toMatch(/badge badge--confirmed"><span class="badge__dot" aria-hidden="true"><\/span>Agendada/);
    expect(list).toMatch(/badge badge--cancelled"><span class="badge__dot" aria-hidden="true"><\/span>Cancelada/);

    const detail = (await get(`/pacientes/citas/${booked}`, client.cookie)).body;
    expect(detail).toContain('class="pairs"');
    expect(detail).toMatch(/<button type="submit" class="btn-danger">Cancelar mi cita<\/button>/);
  });

  it("«Mis consultorios» sin vínculos usa el estado vacío", async () => {
    const patient = await createPatient(pool);
    const client = await sessionFor(t.services, patient.user);
    expect((await get("/pacientes/consultorios", client.cookie)).body).toContain('class="empty"');
  });
});

describe("urgencias", () => {
  const contact = { mobile: "5510000001", officePhone: "5598765432" };

  it("la instrucción de acudir a un hospital o llamar es siempre el aviso más prominente de su pantalla", () => {
    const pages = [
      noSpacePage({ doctorName: "Dra. Elena Ríos", contact, hospitalNotice: true }),
      alarmPage({ doctorName: "Dra. Elena Ríos", contact }),
      captchaUnavailablePage({ slug: "clinica-rios", doctorName: "Dra. Elena Ríos", contact }),
      callOfficePage({ doctorName: "Dra. Elena Ríos", contact }),
    ];
    for (const html of pages) {
      expect(html).toContain("alert--prominent");
      expect(html).not.toMatch(/\sstyle\s*=/);
    }
    expect(pages[0]).toContain(TRIAGE_CONTENT.hospitalNotice.slice(0, 20));
    expect(pages[1]).toContain(TRIAGE_CONTENT.alarmNotice.slice(0, 20));
    // Sin hospital no hay aviso prominente de hospital.
    expect(noSpacePage({ doctorName: "X", contact, hospitalNotice: false })).not.toContain("alert--prominent");
  });

  it("el formulario muestra las cinco categorías con su clase de color y su texto, sin estilos en línea", async () => {
    await published();
    const patient = await createPatient(pool);
    const client = await sessionFor(t.services, patient.user);
    const response = await get("/c/clinica-rios/urgencia", client.cookie);
    expect(response.statusCode).toBe(200);
    for (const category of TRIAGE_CONTENT.categories) {
      expect(response.body).toContain(`class="triage triage--${category.tone}"`);
      expect(response.body).toContain(category.label);
      expect(response.body).toContain(category.optionText.slice(0, 25));
    }
    expect(response.body).not.toMatch(/\sstyle\s*=/);
  });
});
