import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTables, createDoctor, createDoctorSite, createPatient, createPublishedSite, createTestPool, resetDatabase } from "../integration/helpers/db.js";
import { PNG, agendaClientFor, createTestApp, sessionFor, uniqueIp, type TestApp } from "../integration/helpers/app.js";

const pool = createTestPool();
let t: TestApp; // sin clave de mapa
let tMap: TestApp; // con clave de mapa

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
  tMap = await createTestApp(pool, { GOOGLE_MAPS_EMBED_KEY: "clave-de-prueba-del-mapa" });
});

beforeEach(async () => {
  await clearTables(pool);
});

afterAll(async () => {
  await t.app.close();
  await tMap.app.close();
  await pool.end();
});

function get(app: TestApp, url: string, options: { accept?: string; cookie?: string; ip?: string } = {}) {
  return app.app.inject({
    method: "GET",
    url,
    remoteAddress: options.ip ?? uniqueIp(),
    headers: { accept: options.accept ?? "text/html", ...(options.cookie ? { cookie: options.cookie } : {}) },
  });
}

async function published(name = "Dra. Elena Ríos", slug = "clinica-rios") {
  const doctor = await createDoctor(pool, { fullName: name });
  await createPublishedSite(pool, doctor, { slug });
  return doctor;
}

describe("GET /c/:slug publicado", () => {
  it("muestra nombre, dirección, teléfono, las dos opciones y el pie con el aviso de privacidad; sin horarios ni datos de pacientes", async () => {
    await published();
    const patient = await createPatient(pool, { fullName: "Paciente Privado" });
    const response = await get(t, "/c/clinica-rios");
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Dra. Elena Ríos");
    expect(response.body).toContain("Calle Falsa 123, Centro");
    expect(response.body).toContain("55 9876 5432");
    expect(response.body).toContain('href="/c/clinica-rios/primera-cita"');
    expect(response.body).toContain('href="/c/clinica-rios/entrar"');
    expect(response.body).toContain('href="/legal"');
    expect(response.body).toContain('name="robots" content="noindex"');
    expect(response.body).not.toContain("Paciente Privado");
    expect(response.body).not.toContain(patient.user.email);
    expect(response.body).not.toMatch(/\b\d{2}:\d{2}\b/); // ningún horario
  });

  it("en JSON devuelve solo los datos públicos", async () => {
    await published();
    const response = await get(t, "/c/clinica-rios", { accept: "application/json" });
    expect(response.json()).toEqual({ kind: "published", slug: "clinica-rios", doctorName: "Dra. Elena Ríos", address: "Calle Falsa 123, Centro", officePhone: "5598765432", hasLogo: false, map: false });
  });

  it("escapa el nombre del médico y la dirección", async () => {
    const doctor = await createDoctor(pool, { fullName: "<img src=x onerror=alert(1)>" });
    await createPublishedSite(pool, doctor, { slug: "clinica-xss" });
    await pool.execute("UPDATE doctor_site SET address = '<script>alert(1)</script>' WHERE doctor_id = ?", [doctor.doctorId]);
    const response = await get(t, "/c/clinica-xss");
    expect(response.body).not.toContain("<img src=x");
    expect(response.body).not.toContain("<script>alert(1)</script>");
    expect(response.body).toContain("&lt;img");
  });

  it("sin clave de mapa muestra solo la dirección en texto; con clave, un iframe del proveedor con la dirección codificada y la CSP lo permite", async () => {
    await published();
    const withoutKey = await get(t, "/c/clinica-rios");
    expect(withoutKey.body).not.toContain("<iframe");
    expect(String(withoutKey.headers["content-security-policy"])).not.toContain("frame-src https://www.google.com");

    const withKey = await get(tMap, "/c/clinica-rios");
    expect(withKey.body).toContain("<iframe");
    expect(withKey.body).toContain("https://www.google.com/maps/embed/v1/place?key=clave-de-prueba-del-mapa&amp;q=Calle%20Falsa%20123%2C%20Centro");
    expect(String(withKey.headers["content-security-policy"])).toContain("frame-src https://www.google.com");
    expect((await get(tMap, "/c/clinica-rios", { accept: "application/json" })).json()).toMatchObject({ map: true });
    // La CSP ampliada es solo del micrositio.
    expect(String((await get(tMap, "/login")).headers["content-security-policy"])).not.toContain("frame-src https://www.google.com");
  });

  it("con sesión de paciente redirige al calendario; con sesión del personal se ve el micrositio", async () => {
    await published();
    const patient = await createPatient(pool);
    const patientClient = await sessionFor(t.services, patient.user);
    const redirect = await get(t, "/c/clinica-rios", { cookie: patientClient.cookie });
    expect(redirect.statusCode).toBe(303);
    expect(redirect.headers.location).toBe("/c/clinica-rios/reservar");

    const staff = await agendaClientFor(t, pool, "doctor");
    expect((await get(t, "/c/clinica-rios", { cookie: staff.client.cookie })).statusCode).toBe(200);
  });
});

describe("estados que no aceptan reservas", () => {
  it("nunca publicado (borrador) y nombre inexistente responden 404 idéntico a cualquier ruta inexistente, en HTML y en JSON", async () => {
    const doctor = await createDoctor(pool);
    await createDoctorSite(pool, doctor.doctorId, { slug: "en-borrador", status: "draft" });
    for (const accept of ["text/html", "application/json"]) {
      const unknownRoute = await get(t, "/ruta-que-no-existe", { accept });
      for (const slug of ["en-borrador", "no-existe", "Clinica-Rios", "a"]) {
        const response = await get(t, `/c/${slug}`, { accept });
        expect(response.statusCode, slug).toBe(404);
        expect(response.body, slug).toBe(unknownRoute.body);
      }
    }
  });

  it("despublicado tras haberse publicado: aviso con nombre y teléfono, sin calendario ni opciones de reserva", async () => {
    const doctor = await published("Dr. Mario Soto", "clinica-soto");
    await pool.execute("UPDATE doctor_site SET status = 'unpublished' WHERE doctor_id = ?", [doctor.doctorId]);
    const response = await get(t, "/c/clinica-soto");
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Dr. Mario Soto");
    expect(response.body).toContain("55 9876 5432");
    expect(response.body).not.toContain("primera-cita");
    expect(response.body).not.toContain("/entrar");
    expect(response.body).not.toContain("Calle Falsa");
    expect((await get(t, "/c/clinica-soto", { accept: "application/json" })).json()).toEqual({ kind: "unavailable", doctorName: "Dr. Mario Soto", officePhone: "5598765432" });
  });

  it("un médico que dejó de estar aprobado muestra el mismo aviso aunque siga publicado", async () => {
    const doctor = await published("Dr. Suspendido", "dr-suspendido");
    await pool.execute("UPDATE doctor SET approval_status = 'rejected' WHERE id = ?", [doctor.doctorId]);
    const response = await get(t, "/c/dr-suspendido", { accept: "application/json" });
    expect(response.json()).toMatchObject({ kind: "unavailable", doctorName: "Dr. Suspendido" });
  });
});

describe("GET /c/:slug/logo", () => {
  it("sirve el logo con tipo fijo y nosniff solo si el micrositio está publicado", async () => {
    const doctor = await published();
    const saved = await t.services.logos.save(PNG);
    await pool.execute("UPDATE doctor_site SET logo_file = ? WHERE doctor_id = ?", [saved.name, doctor.doctorId]);

    const response = await get(t, "/c/clinica-rios/logo");
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.from(response.rawPayload).equals(PNG)).toBe(true);
    expect((await get(t, "/c/clinica-rios")).body).toContain('src="/c/clinica-rios/logo"');
    expect((await get(t, "/c/clinica-rios", { accept: "application/json" })).json()).toMatchObject({ hasLogo: true });

    await pool.execute("UPDATE doctor_site SET status = 'unpublished' WHERE doctor_id = ?", [doctor.doctorId]);
    expect((await get(t, "/c/clinica-rios/logo")).statusCode).toBe(404);
  });

  it("sin logo, con nombre inexistente o con un archivo que ya no está responde 404", async () => {
    const doctor = await published();
    expect((await get(t, "/c/clinica-rios/logo")).statusCode).toBe(404);
    expect((await get(t, "/c/no-existe/logo")).statusCode).toBe(404);
    await pool.execute("UPDATE doctor_site SET logo_file = ? WHERE doctor_id = ?", [`${"a".repeat(32)}.png`, doctor.doctorId]);
    expect((await get(t, "/c/clinica-rios/logo")).statusCode).toBe(404);
  });

  it("un nombre de archivo manipulado en la base nunca sale del directorio de logos", async () => {
    const doctor = await published();
    await pool.execute("UPDATE doctor_site SET logo_file = '../secreto.png' WHERE doctor_id = ?", [doctor.doctorId]);
    expect((await get(t, "/c/clinica-rios/logo")).statusCode).toBe(404);
  });
});

describe("límite de peticiones por IP", () => {
  it("la petición 121 en un minuto desde la misma IP recibe 429", async () => {
    await published();
    const ip = "10.250.250.250";
    let last = 0;
    for (let index = 0; index < 121; index += 1) last = (await get(t, "/c/clinica-rios", { ip, accept: "application/json" })).statusCode;
    expect(last).toBe(429);
    // Otra IP no se ve afectada.
    expect((await get(t, "/c/clinica-rios", { accept: "application/json" })).statusCode).toBe(200);
  });
});
