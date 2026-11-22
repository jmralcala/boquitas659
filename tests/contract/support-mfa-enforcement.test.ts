import { generate } from "otplib";
import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTables, createDoctor, createTestPool, createUser, resetDatabase } from "../integration/helpers/db.js";
import { createTestApp, loginRequest, postForm, sessionFor, type TestApp } from "../integration/helpers/app.js";

const pool = createTestPool();
let t: TestApp;

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

async function status(doctorId: number): Promise<string> {
  const [rows] = await pool.query<RowDataPacket[]>("SELECT approval_status AS s FROM doctor WHERE id = ?", [doctorId]);
  return String(rows[0]?.s);
}

/** Soporte con doble factor activo (se activa por el servicio, como lo haría la pantalla de alta). */
async function supportWithMfa() {
  const user = await createUser(pool, { role: "support" });
  const { secret } = await t.services.mfa.beginEnrollment(user.id);
  const confirmed = await t.services.mfa.confirmEnrollment(user.id, await generate({ secret, epoch: t.clock.now().getTime() / 1000 }));
  expect(confirmed).not.toBeNull();
  return { user, secret };
}

const get = (url: string, cookie: string, json = true) =>
  t.app.inject({ method: "GET", url, headers: { cookie, ...(json ? { accept: "application/json" } : {}) } });

describe("soporte sin doble factor configurado", () => {
  it("solo puede llegar a la pantalla de alta; el resto devuelve 403 (JSON) o lo lleva al alta (navegador)", async () => {
    const support = await createUser(pool, { role: "support" });
    const client = await sessionFor(t.services, support);
    // Sesión de soporte sin TOTP: se simula como tras un inicio de sesión con contraseña.
    for (const url of ["/soporte/medicos", "/soporte/medicos/1", "/soporte/medicos/1/cedula", "/cuenta/contrasena", "/cuenta/correo"]) {
      const api = await get(url, client.cookie);
      expect(api.statusCode, url).toBe(403);
      expect(api.json().error).toBe("mfa_enrollment_required");
      const browser = await get(url, client.cookie, false);
      expect(browser.statusCode, url).toBe(303);
      expect(browser.headers.location).toBe("/cuenta/mfa/alta");
    }
  });

  it("puede ver la pantalla de alta, el estado del doble factor, los avisos legales y cerrar sesión", async () => {
    const support = await createUser(pool, { role: "support" });
    const client = await sessionFor(t.services, support);
    for (const url of ["/cuenta/mfa/alta", "/cuenta/mfa", "/legal", "/derechos"]) {
      expect((await get(url, client.cookie, false)).statusCode, url).toBe(200);
    }
    const logout = await postForm(t.app, "/logout", { _csrf: client.csrf }, client.cookie);
    expect(logout.statusCode).toBe(303);
  });

  it("no puede aprobar médicos mientras no active el doble factor", async () => {
    const support = await createUser(pool, { role: "support" });
    const client = await sessionFor(t.services, support);
    const doctor = await createDoctor(pool, { status: "pending" });
    const response = await t.app.inject({
      method: "POST",
      url: `/soporte/medicos/${doctor.doctorId}/aprobar`,
      headers: { cookie: client.cookie, "x-csrf-token": client.csrf, accept: "application/json" },
    });
    expect(response.statusCode).toBe(403);
    expect(await status(doctor.doctorId)).toBe("pending");
  });

  it("el inicio de sesión de soporte lo lleva al alta del doble factor", async () => {
    const support = await createUser(pool, { role: "support" });
    const login = await loginRequest(t.app, support.email, support.password);
    expect(login.statusCode).toBe(303);
    const cookie = `__Host-sid=${login.cookies.find((c) => c.name === "__Host-sid")?.value}`;
    const next = await get(login.headers.location as string, cookie, false);
    expect(next.statusCode).toBe(303);
    expect(next.headers.location).toBe("/cuenta/mfa/alta");
  });
});

describe("soporte con doble factor", () => {
  it("con el TOTP activo pero sin verificar en la sesión no accede a /soporte/* (401)", async () => {
    const { user } = await supportWithMfa();
    t.clock.advance(60_000);
    const login = await loginRequest(t.app, user.email, user.password);
    expect(login.headers.location).toBe("/login/mfa");
    const cookie = `__Host-sid=${login.cookies.find((c) => c.name === "__Host-sid")?.value}`;
    expect((await get("/soporte/medicos", cookie)).statusCode).toBe(401);
  });

  it("con el TOTP verificado en la sesión entra y puede aprobar", async () => {
    const { user, secret } = await supportWithMfa();
    t.clock.advance(60_000);
    const login = await loginRequest(t.app, user.email, user.password);
    const partial = `__Host-sid=${login.cookies.find((c) => c.name === "__Host-sid")?.value}`;
    const form = await get("/login/mfa", partial, false);
    const csrf = /name="_csrf" value="([^"]+)"/.exec(form.body)?.[1] ?? "";
    const verified = await postForm(t.app, "/login/mfa", { code: await generate({ secret, epoch: t.clock.now().getTime() / 1000 }), _csrf: csrf }, partial);
    expect(verified.statusCode).toBe(303);
    expect(verified.headers.location).toBe("/soporte/medicos");

    const cookie = `__Host-sid=${verified.cookies.find((c) => c.name === "__Host-sid")?.value}`;
    expect((await get("/soporte/medicos", cookie)).statusCode).toBe(200);
  });
});

describe("el resto de los roles no se ve afectado", () => {
  it("médicos y recepción usan el producto sin doble factor", async () => {
    const doctor = await createDoctor(pool);
    const reception = await createUser(pool, { role: "reception" });
    for (const user of [doctor.user, reception]) {
      const client = await sessionFor(t.services, user);
      const url = user.role === "doctor" ? "/medicos/panel" : "/recepcion/panel";
      expect((await get(url, client.cookie, false)).statusCode, user.role).toBe(200);
    }
  });
});
