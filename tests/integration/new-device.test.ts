import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, loginRequest, type TestApp } from "./helpers/app.js";
import { clearTables, createTestPool, createUser, resetDatabase } from "./helpers/db.js";

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

function deviceCookieOf(response: { cookies: { name: string; value: string }[] }): string | undefined {
  return response.cookies.find((c) => c.name === "__Host-did")?.value;
}

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

describe("aviso de dispositivo nuevo", () => {
  it("un inicio de sesión sin cookie de dispositivo registra el dispositivo, escribe el evento y encola el aviso", async () => {
    const user = await createUser(pool, { email: "ana@example.com" });
    const response = await loginRequest(t.app, user.email, user.password);
    expect(response.statusCode).toBe(303);

    const cookie = response.cookies.find((c) => c.name === "__Host-did");
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", path: "/" });
    expect(cookie?.maxAge ?? 0).toBeGreaterThan(30 * 24 * 3600); // cookie de larga vida

    expect(await rows("SELECT user_id FROM trusted_device")).toEqual([{ user_id: user.id }]);
    expect(await rows("SELECT type FROM security_event WHERE user_id = ?", [user.id])).toEqual([{ type: "new_device" }]);
    const outbox = await rows("SELECT template, to_email FROM email_outbox");
    expect(outbox).toEqual([{ template: "new_device_login", to_email: "ana@example.com" }]);

    await t.runOutbox();
    const email = t.transport.sent[0];
    expect(email?.subject).not.toContain("ana");
    expect(email?.text).toContain("/cuenta/contrasena");
  });

  it("con la cookie de un dispositivo conocido no se vuelve a avisar", async () => {
    const user = await createUser(pool);
    const first = await loginRequest(t.app, user.email, user.password);
    const device = deviceCookieOf(first);
    expect(device).toBeDefined();

    const second = await loginRequest(t.app, user.email, user.password, { extraCookies: `__Host-did=${device}` });
    expect(second.statusCode).toBe(303);
    expect(await rows("SELECT COUNT(*) AS n FROM email_outbox WHERE template = 'new_device_login'")).toEqual([{ n: 1 }]);
    expect(await rows("SELECT COUNT(*) AS n FROM security_event WHERE type = 'new_device'")).toEqual([{ n: 1 }]);
    expect(await rows("SELECT COUNT(*) AS n FROM trusted_device")).toEqual([{ n: 1 }]);
    const [device1] = await rows("SELECT last_seen_at, first_seen_at FROM trusted_device");
    expect((device1?.last_seen_at as Date).getTime()).toBeGreaterThanOrEqual((device1?.first_seen_at as Date).getTime());
  });

  it("la misma cookie con otra cuenta cuenta como dispositivo nuevo para esa cuenta", async () => {
    const a = await createUser(pool);
    const b = await createUser(pool);
    const first = await loginRequest(t.app, a.email, a.password);
    const device = deviceCookieOf(first);
    await loginRequest(t.app, b.email, b.password, { extraCookies: `__Host-did=${device}` });

    expect(await rows("SELECT COUNT(*) AS n FROM trusted_device")).toEqual([{ n: 2 }]);
    expect(await rows("SELECT COUNT(*) AS n FROM email_outbox WHERE template = 'new_device_login'")).toEqual([{ n: 2 }]);
  });

  it("solo se guarda el hash del identificador del dispositivo, ligado a la cuenta", async () => {
    const a = await createUser(pool);
    const b = await createUser(pool);
    const first = await loginRequest(t.app, a.email, a.password);
    const device = deviceCookieOf(first) ?? "";
    await loginRequest(t.app, b.email, b.password, { extraCookies: `__Host-did=${device}` });

    const stored = await rows("SELECT device_hash FROM trusted_device ORDER BY user_id");
    expect(stored).toHaveLength(2);
    for (const row of stored) {
      expect(String(row.device_hash)).toMatch(/^[0-9a-f]{64}$/);
      expect(String(row.device_hash)).not.toContain(device);
    }
    // El mismo identificador produce hashes distintos para cuentas distintas.
    expect(stored[0]?.device_hash).not.toBe(stored[1]?.device_hash);
  });

  it("un inicio fallido no registra dispositivos ni envía avisos", async () => {
    const user = await createUser(pool);
    await loginRequest(t.app, user.email, "contraseña-incorrecta-1");
    expect(await rows("SELECT COUNT(*) AS n FROM trusted_device")).toEqual([{ n: 0 }]);
    expect(await rows("SELECT COUNT(*) AS n FROM email_outbox")).toEqual([{ n: 0 }]);
  });

  it("una cookie de dispositivo malformada se reemplaza por una nueva", async () => {
    const user = await createUser(pool);
    const response = await loginRequest(t.app, user.email, user.password, { extraCookies: "__Host-did=corto" });
    expect(response.statusCode).toBe(303);
    const device = deviceCookieOf(response);
    expect(device).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
