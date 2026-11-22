import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFixedClock, type FixedClock } from "../../src/lib/clock.js";
import { createSessionService, type SessionService } from "../../src/modules/auth/sessions.js";
import { clearTables, createTestPool, createUser, resetDatabase } from "./helpers/db.js";

const pool = createTestPool();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let clock: FixedClock;
let sessions: SessionService;

beforeAll(async () => {
  await resetDatabase(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  clock = createFixedClock(new Date("2026-06-01T10:00:00.000Z"));
  sessions = createSessionService(pool, clock);
});

afterAll(async () => {
  await pool.end();
});

describe("SessionService", () => {
  it("crea una sesión válida y guarda solo el hash del token", async () => {
    const user = await createUser(pool, { role: "doctor" });
    const { token } = await sessions.create(user.id);

    const session = await sessions.validate(token);
    expect(session).toMatchObject({ userId: user.id, role: "doctor", mfaVerified: false, activeDoctorId: null });
    expect(session?.csrfSecret.length).toBeGreaterThan(20);

    const [rows] = await pool.query<RowDataPacket[]>("SELECT token_hash FROM session");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.token_hash).not.toBe(token);
  });

  it("rechaza tokens vacíos, desconocidos o malformados", async () => {
    expect(await sessions.validate("")).toBeNull();
    expect(await sessions.validate("no-existe")).toBeNull();
    expect(await sessions.validate("' OR 1=1 --")).toBeNull();
  });

  it("caduca por inactividad: 30 minutos para personal y 60 para pacientes", async () => {
    const doctor = await createUser(pool, { role: "doctor" });
    const patient = await createUser(pool, { role: "patient" });
    const d = await sessions.create(doctor.id);
    const p = await sessions.create(patient.id);

    clock.advance(29 * MINUTE);
    expect(await sessions.validate(d.token)).not.toBeNull();
    expect(await sessions.validate(p.token)).not.toBeNull();

    clock.advance(31 * MINUTE); // médico: 31 min sin actividad; paciente: 31 min desde su última visita
    expect(await sessions.validate(d.token)).toBeNull();
    expect(await sessions.validate(p.token)).not.toBeNull();

    clock.advance(61 * MINUTE);
    expect(await sessions.validate(p.token)).toBeNull();
  });

  it("la actividad renueva la inactividad, pero el tope absoluto de 12 horas se respeta", async () => {
    const user = await createUser(pool, { role: "doctor" });
    const { token } = await sessions.create(user.id);

    for (let i = 0; i < 23; i += 1) {
      clock.advance(25 * MINUTE);
      expect(await sessions.validate(token)).not.toBeNull();
    }
    // Han pasado 9 h 35 min con actividad constante.
    clock.advance(25 * MINUTE);
    expect(await sessions.validate(token)).not.toBeNull();
    for (let i = 0; i < 6; i += 1) clock.advance(25 * MINUTE);
    // Más de 12 h desde la creación: caducó aunque hubo actividad reciente.
    expect(clock.now().getTime() - new Date("2026-06-01T10:00:00.000Z").getTime()).toBeGreaterThan(12 * HOUR);
    expect(await sessions.validate(token)).toBeNull();
  });

  it("revocar corta el acceso", async () => {
    const user = await createUser(pool);
    const { token } = await sessions.create(user.id);
    await sessions.revoke(token);
    expect(await sessions.validate(token)).toBeNull();
  });

  it("revokeAllForUser cierra todas las sesiones, salvo la indicada", async () => {
    const user = await createUser(pool);
    const a = await sessions.create(user.id);
    const b = await sessions.create(user.id);
    const other = await createUser(pool);
    const c = await sessions.create(other.id);

    const keep = await sessions.validate(a.token);
    await sessions.revokeAllForUser(user.id, keep?.sessionId);

    expect(await sessions.validate(a.token)).not.toBeNull();
    expect(await sessions.validate(b.token)).toBeNull();
    expect(await sessions.validate(c.token)).not.toBeNull();
  });

  it("una cuenta deshabilitada no puede usar su sesión", async () => {
    const user = await createUser(pool);
    const { token } = await sessions.create(user.id);
    await pool.execute("UPDATE `user` SET status = 'disabled' WHERE id = ?", [user.id]);
    expect(await sessions.validate(token)).toBeNull();
  });

  it("rotate entrega un token nuevo, invalida el anterior y puede subir de privilegio", async () => {
    const user = await createUser(pool, { role: "support" });
    const { token } = await sessions.create(user.id);
    const session = await sessions.validate(token);

    const rotated = await sessions.rotate(session!.sessionId, { mfaVerified: true });
    expect(rotated.token).not.toBe(token);
    expect(await sessions.validate(token)).toBeNull();
    expect(await sessions.validate(rotated.token)).toMatchObject({ mfaVerified: true });
  });

  it("setActiveDoctor guarda el médico activo de la sesión", async () => {
    const user = await createUser(pool, { role: "reception" });
    const { token } = await sessions.create(user.id);
    const session = await sessions.validate(token);
    await sessions.setActiveDoctor(session!.sessionId, 77);
    expect(await sessions.validate(token)).toMatchObject({ activeDoctorId: 77 });
    await sessions.setActiveDoctor(session!.sessionId, null);
    expect(await sessions.validate(token)).toMatchObject({ activeDoctorId: null });
  });
});
