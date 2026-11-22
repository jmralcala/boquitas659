import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFixedClock, type FixedClock } from "../../src/lib/clock.js";
import { createLoginThrottle, type LoginThrottle } from "../../src/modules/auth/login-throttle.js";
import { createTestApp, loginRequest, type TestApp } from "./helpers/app.js";
import { clearTables, createTestPool, createUser, resetDatabase } from "./helpers/db.js";

const pool = createTestPool();
const SECRET = "t".repeat(40);

beforeAll(async () => {
  await resetDatabase(pool);
});

beforeEach(async () => {
  await clearTables(pool);
});

afterAll(async () => {
  await pool.end();
});

describe("LoginThrottle (servicio)", () => {
  let clock: FixedClock;
  let throttle: LoginThrottle;

  beforeEach(() => {
    clock = createFixedClock(new Date("2026-06-01T10:00:00.000Z"));
    throttle = createLoginThrottle(pool, clock, SECRET, {
      baseDelayMs: 1000,
      maxDelayMs: 10_000,
      ipFreeAttempts: 3,
      resetAfterMs: 60 * 60_000,
    });
  });

  it("cada fallo duplica la espera (1, 2, 4, 8 s) hasta el máximo configurable", async () => {
    const key = throttle.accountKey("ana@example.com");
    const waits: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      await throttle.recordFailure(key, "203.0.113.1");
      const gate = await throttle.check(key, "203.0.113.50");
      waits.push(gate.retryAfterMs);
      clock.advance(gate.retryAfterMs + 1);
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000, 10_000, 10_000]);
  });

  it("mientras dura la espera no permite intentar, y después sí", async () => {
    const key = throttle.accountKey("ana@example.com");
    expect(await throttle.check(key, "203.0.113.1")).toEqual({ allowed: true, retryAfterMs: 0 });
    await throttle.recordFailure(key, "203.0.113.1");
    expect(await throttle.check(key, "203.0.113.2")).toMatchObject({ allowed: false });
    clock.advance(999);
    expect((await throttle.check(key, "203.0.113.2")).allowed).toBe(false);
    clock.advance(2);
    expect((await throttle.check(key, "203.0.113.2")).allowed).toBe(true);
  });

  it("el éxito reinicia el contador de la cuenta", async () => {
    const key = throttle.accountKey("ana@example.com");
    for (let i = 0; i < 3; i += 1) {
      await throttle.recordFailure(key, "203.0.113.1");
      clock.advance(60_000);
    }
    await throttle.recordSuccess(key);
    await throttle.recordFailure(key, "203.0.113.1");
    expect((await throttle.check(key, "203.0.113.9")).retryAfterMs).toBe(1000);
  });

  it("por IP: las primeras 3 fallas no bloquean y desde la cuarta la espera crece", async () => {
    for (let i = 0; i < 3; i += 1) {
      await throttle.recordFailure(throttle.accountKey(`persona${i}@example.com`), "203.0.113.7");
    }
    expect(await throttle.check(throttle.accountKey("otra@example.com"), "203.0.113.7")).toEqual({
      allowed: true,
      retryAfterMs: 0,
    });
    await throttle.recordFailure(throttle.accountKey("persona9@example.com"), "203.0.113.7");
    const gate = await throttle.check(throttle.accountKey("otra@example.com"), "203.0.113.7");
    expect(gate).toEqual({ allowed: false, retryAfterMs: 1000 });
    // Otra IP no se ve afectada.
    expect((await throttle.check(throttle.accountKey("otra@example.com"), "203.0.113.8")).allowed).toBe(true);
  });

  it("los fallos viejos se olvidan tras la ventana de reinicio", async () => {
    const key = throttle.accountKey("ana@example.com");
    for (let i = 0; i < 4; i += 1) {
      await throttle.recordFailure(key, "203.0.113.1");
      clock.advance(20_000);
    }
    clock.advance(2 * 60 * 60_000);
    await throttle.recordFailure(key, "203.0.113.1");
    expect((await throttle.check(key, "203.0.113.1")).retryAfterMs).toBe(1000);
  });

  it("guarda solo hashes: ni el correo ni la IP aparecen en claro", async () => {
    await throttle.recordFailure(throttle.accountKey("ana.perez@example.com"), "203.0.113.55");
    const [rows] = await pool.query<RowDataPacket[]>("SELECT scope, key_hash FROM login_throttle ORDER BY scope");
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(String(row.key_hash)).toMatch(/^[0-9a-f]{64}$/);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain("ana.perez");
    expect(dump).not.toContain("203.0.113.55");
  });

  it("la clave de cuenta normaliza el correo y depende del secreto", () => {
    expect(throttle.accountKey("  ANA@Example.com ")).toBe(throttle.accountKey("ana@example.com"));
    const other = createLoginThrottle(pool, clock, "otro-secreto-distinto-de-32-caracteres!!");
    expect(other.accountKey("ana@example.com")).not.toBe(throttle.accountKey("ana@example.com"));
  });
});

describe("POST /login con límite de intentos", () => {
  let t: TestApp;
  const IP = "198.51.100.200";

  beforeAll(async () => {
    t = await createTestApp(pool);
  });

  afterAll(async () => {
    await t.app.close();
  });

  async function sequence(email: string, password: string): Promise<number[]> {
    const statuses: number[] = [];
    // 1.er intento: 401. Inmediato: 429 (espera de 1 s). Pasada la espera: 401. Inmediato: 429 (espera de 2 s).
    statuses.push((await loginRequest(t.app, email, password, { ip: IP })).statusCode);
    statuses.push((await loginRequest(t.app, email, password, { ip: IP })).statusCode);
    t.clock.advance(1100);
    statuses.push((await loginRequest(t.app, email, password, { ip: IP })).statusCode);
    statuses.push((await loginRequest(t.app, email, password, { ip: IP })).statusCode);
    t.clock.advance(2100);
    return statuses;
  }

  it("un correo real y uno inexistente reciben exactamente la misma secuencia de respuestas", async () => {
    const user = await createUser(pool, { email: "real@example.com" });
    const real = await sequence(user.email, "contraseña-incorrecta-1");
    const unknown = await sequence("fantasma@example.com", "contraseña-incorrecta-1");
    expect(real).toEqual([401, 429, 401, 429]);
    expect(unknown).toEqual(real);
  });

  it("la respuesta 429 incluye Retry-After y no revela si el correo existe", async () => {
    const user = await createUser(pool, { email: "real2@example.com" });
    await loginRequest(t.app, user.email, "mala-contraseña-123", { ip: IP });
    const blockedReal = await loginRequest(t.app, user.email, "mala-contraseña-123", { ip: IP });
    t.clock.advance(5000);
    await loginRequest(t.app, "fantasma2@example.com", "mala-contraseña-123", { ip: IP });
    const blockedUnknown = await loginRequest(t.app, "fantasma2@example.com", "mala-contraseña-123", { ip: IP });
    expect(blockedReal.statusCode).toBe(429);
    expect(blockedReal.headers["retry-after"]).toBeDefined();
    const clean = (body: string) => body.replace(/name="_csrf" value="[^"]+"/, "").replace(/value="[^"]*"/g, "").replace(/\d+ segundo/, "N segundo");
    expect(clean(blockedReal.body)).toBe(clean(blockedUnknown.body));
  });

  it("tras la espera, la contraseña correcta entra y reinicia el contador", async () => {
    const user = await createUser(pool, { email: "real3@example.com" });
    await loginRequest(t.app, user.email, "mala-contraseña-123", { ip: IP });
    t.clock.advance(1100);
    const ok = await loginRequest(t.app, user.email, user.password, { ip: IP });
    expect(ok.statusCode).toBe(303);
    // Contador reiniciado: un nuevo fallo vuelve a esperar solo 1 s.
    await loginRequest(t.app, user.email, "mala-contraseña-123", { ip: IP });
    t.clock.advance(1100);
    expect((await loginRequest(t.app, user.email, "mala-contraseña-123", { ip: IP })).statusCode).toBe(401);
  });

  it("estando en espera, ni la contraseña correcta entra (no se puede adivinar sin pagar la espera)", async () => {
    const user = await createUser(pool, { email: "real4@example.com" });
    await loginRequest(t.app, user.email, "mala-contraseña-123", { ip: IP });
    const response = await loginRequest(t.app, user.email, user.password, { ip: IP });
    expect(response.statusCode).toBe(429);
  });
});

describe("LoginThrottle: fallos simultáneos", () => {
  it("nunca acortan una espera ya fijada por otro intento", async () => {
    const clock = createFixedClock(new Date("2026-06-01T10:00:00.000Z"));
    const throttle = createLoginThrottle(pool, clock, SECRET, { baseDelayMs: 1000, maxDelayMs: 10_000, ipFreeAttempts: 3, resetAfterMs: 3_600_000 });
    const key = throttle.accountKey("ana@example.com");
    await Promise.all(Array.from({ length: 8 }, () => throttle.recordFailure(key, "203.0.113.1")));
    expect((await throttle.check(key, "203.0.113.9")).retryAfterMs).toBe(10_000);
  });
});
