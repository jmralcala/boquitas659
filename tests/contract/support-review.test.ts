import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTables, createDoctor, createTestPool, createUser, resetDatabase } from "../integration/helpers/db.js";
import { JPEG, PDF, createSupportWithMfa, createTestApp, postForm, sessionFor, type AuthedClient, type TestApp } from "../integration/helpers/app.js";

const pool = createTestPool();
let t: TestApp;
let support: AuthedClient;

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  support = await sessionFor(t.services, await createSupportWithMfa(t, pool));
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

async function status(doctorId: number): Promise<string> {
  const [rows] = await pool.query<RowDataPacket[]>("SELECT approval_status AS s FROM doctor WHERE id = ?", [doctorId]);
  return String(rows[0]?.s);
}

describe("acceso a /soporte/*", () => {
  it("solo admite el rol de soporte", async () => {
    const doctor = await createDoctor(pool, { status: "pending" });
    const rutas = ["/soporte/medicos", `/soporte/medicos/${doctor.doctorId}`, `/soporte/medicos/${doctor.doctorId}/cedula`];

    for (const url of rutas) {
      expect((await t.app.inject({ method: "GET", url, headers: { accept: "application/json" } })).statusCode).toBe(401);
    }
    for (const role of ["patient", "doctor", "reception"] as const) {
      const client = await sessionFor(t.services, await createUser(pool, { role }));
      for (const url of rutas) {
        const response = await t.app.inject({ method: "GET", url, headers: { cookie: client.cookie, accept: "application/json" } });
        expect(response.statusCode, `${role} ${url}`).toBe(403);
      }
      const post = await postForm(t.app, `/soporte/medicos/${doctor.doctorId}/aprobar`, { _csrf: client.csrf }, client.cookie);
      expect(post.statusCode, role).toBe(403);
    }
    expect(await status(doctor.doctorId)).toBe("pending");
  });
});

describe("lista y detalle", () => {
  it("la lista muestra las solicitudes pendientes por omisión y filtra por estado", async () => {
    const pending = await createDoctor(pool, { status: "pending", fullName: "Dra. Pendiente" });
    await createDoctor(pool, { status: "approved", fullName: "Dr. Aprobado" });

    const lista = await t.app.inject({ method: "GET", url: "/soporte/medicos", headers: { cookie: support.cookie } });
    expect(lista.statusCode).toBe(200);
    expect(lista.body).toContain("Dra. Pendiente");
    expect(lista.body).not.toContain("Dr. Aprobado");
    expect(lista.body).toContain(`/soporte/medicos/${pending.doctorId}`);

    const aprobados = await t.app.inject({ method: "GET", url: "/soporte/medicos?status=approved", headers: { cookie: support.cookie } });
    expect(aprobados.body).toContain("Dr. Aprobado");
  });

  it("rechaza un filtro de estado inválido y un id que no es numérico", async () => {
    expect((await t.app.inject({ method: "GET", url: "/soporte/medicos?status=otro", headers: { cookie: support.cookie, accept: "application/json" } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: "GET", url: "/soporte/medicos/abc", headers: { cookie: support.cookie, accept: "application/json" } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: "GET", url: "/soporte/medicos/999999", headers: { cookie: support.cookie, accept: "application/json" } })).statusCode).toBe(404);
  });

  it("el detalle escapa los datos del médico", async () => {
    const doctor = await createDoctor(pool, { status: "pending", fullName: "<script>alert(1)</script>" });
    const response = await t.app.inject({ method: "GET", url: `/soporte/medicos/${doctor.doctorId}`, headers: { cookie: support.cookie } });
    expect(response.body).not.toContain("<script>alert(1)</script>");
    expect(response.body).toContain("&lt;script&gt;");
  });
});

describe("decisiones", () => {
  it("aprobar con CSRF válido deja la cuenta aprobada y redirige al detalle", async () => {
    const doctor = await createDoctor(pool, { status: "pending" });
    const response = await postForm(t.app, `/soporte/medicos/${doctor.doctorId}/aprobar`, { _csrf: support.csrf }, support.cookie);
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(`/soporte/medicos/${doctor.doctorId}`);
    expect(await status(doctor.doctorId)).toBe("approved");
  });

  it("sin token CSRF no cambia nada", async () => {
    const doctor = await createDoctor(pool, { status: "pending" });
    const response = await postForm(t.app, `/soporte/medicos/${doctor.doctorId}/aprobar`, {}, support.cookie);
    expect(response.statusCode).toBe(403);
    expect(await status(doctor.doctorId)).toBe("pending");
  });

  it("rechazar exige motivo", async () => {
    const doctor = await createDoctor(pool, { status: "pending" });
    const sinMotivo = await postForm(t.app, `/soporte/medicos/${doctor.doctorId}/rechazar`, { _csrf: support.csrf, reason: "  " }, support.cookie);
    expect(sinMotivo.statusCode).toBe(400);
    expect(await status(doctor.doctorId)).toBe("pending");

    const conMotivo = await postForm(t.app, `/soporte/medicos/${doctor.doctorId}/rechazar`, { _csrf: support.csrf, reason: "Cédula ilegible" }, support.cookie);
    expect(conMotivo.statusCode).toBe(303);
    expect(await status(doctor.doctorId)).toBe("rejected");
  });

  it("liberar la cédula pone NULL en cédula y móvil y permite registrarlos de nuevo", async () => {
    const doctor = await createDoctor(pool, { status: "pending" });
    const response = await postForm(t.app, `/soporte/medicos/${doctor.doctorId}/liberar-cedula`, { _csrf: support.csrf, reason: "Registrada por error", confirm: "yes" }, support.cookie);
    expect(response.statusCode).toBe(303);
    const [rows] = await pool.query<RowDataPacket[]>("SELECT cedula_normalized, emergency_mobile FROM doctor WHERE id = ?", [doctor.doctorId]);
    expect(rows[0]).toEqual({ cedula_normalized: null, emergency_mobile: null });
  });

  it("aprobar una cuenta ya resuelta devuelve 409", async () => {
    const doctor = await createDoctor(pool, { status: "approved" });
    const response = await postForm(t.app, `/soporte/medicos/${doctor.doctorId}/aprobar`, { _csrf: support.csrf }, support.cookie);
    expect(response.statusCode).toBe(409);
  });
});

describe("archivo de la cédula", () => {
  it("se entrega con el tipo correcto, sin sniffing y sin caché", async () => {
    const jpeg = await t.services.cedulaStorage.save(JPEG);
    const doctor = await createDoctor(pool, { status: "pending", cedulaFileName: jpeg.name });
    const response = await t.app.inject({ method: "GET", url: `/soporte/medicos/${doctor.doctorId}/cedula`, headers: { cookie: support.cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/jpeg");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(String(response.headers["content-disposition"])).toMatch(/^inline; filename="cedula\.jpg"$/);
    expect(response.rawPayload.equals(JPEG)).toBe(true);

    const pdf = await t.services.cedulaStorage.save(PDF);
    const doctor2 = await createDoctor(pool, { status: "pending", cedulaFileName: pdf.name });
    const response2 = await t.app.inject({ method: "GET", url: `/soporte/medicos/${doctor2.doctorId}/cedula`, headers: { cookie: support.cookie } });
    expect(response2.headers["content-type"]).toBe("application/pdf");
  });

  it("devuelve 404 si el médico no tiene archivo o este no existe", async () => {
    const sin = await createDoctor(pool, { status: "pending" });
    expect((await t.app.inject({ method: "GET", url: `/soporte/medicos/${sin.doctorId}/cedula`, headers: { cookie: support.cookie, accept: "application/json" } })).statusCode).toBe(404);

    const falso = await createDoctor(pool, { status: "pending", cedulaFileName: "../../etc/passwd" });
    expect((await t.app.inject({ method: "GET", url: `/soporte/medicos/${falso.doctorId}/cedula`, headers: { cookie: support.cookie, accept: "application/json" } })).statusCode).toBe(404);
  });
});

describe("historial de soporte", () => {
  it("aprobar, rechazar y liberar la cédula dejan su entrada con autor y fecha en la misma operación", async () => {
    const [users] = await pool.query<RowDataPacket[]>("SELECT id FROM `user` WHERE role = 'support' LIMIT 1");
    const supportId = Number(users[0]?.id);
    const approved = await createDoctor(pool, { status: "pending" });
    const rejected = await createDoctor(pool, { status: "pending" });
    const released = await createDoctor(pool, { status: "pending" });
    await postForm(t.app, `/soporte/medicos/${approved.doctorId}/aprobar`, { _csrf: support.csrf }, support.cookie);
    await postForm(t.app, `/soporte/medicos/${rejected.doctorId}/rechazar`, { _csrf: support.csrf, reason: "Cédula ilegible" }, support.cookie);
    await postForm(t.app, `/soporte/medicos/${released.doctorId}/liberar-cedula`, { _csrf: support.csrf, reason: "Registrada por error", confirm: "yes" }, support.cookie);
    const [rows] = await pool.query<RowDataPacket[]>("SELECT support_user_id, action, target_type, target_id, reason, occurred_at FROM support_action_log ORDER BY id");
    expect(rows.map((row) => [row.action, row.target_id, row.reason])).toEqual([
      ["approve", approved.doctorId, null],
      ["reject", rejected.doctorId, "Cédula ilegible"],
      ["release_cedula", released.doctorId, "Registrada por error"],
    ]);
    for (const row of rows) {
      expect(row.support_user_id).toBe(supportId);
      expect(row.target_type).toBe("doctor");
      expect(row.occurred_at).toBeInstanceOf(Date);
    }
  });

  it("una aprobación rechazada por estado (409) no deja entrada", async () => {
    const doctor = await createDoctor(pool, { status: "approved" });
    await postForm(t.app, `/soporte/medicos/${doctor.doctorId}/aprobar`, { _csrf: support.csrf }, support.cookie);
    const [rows] = await pool.query<RowDataPacket[]>("SELECT id FROM support_action_log");
    expect(rows).toEqual([]);
  });
});
