import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NotFoundError } from "../../src/http/errors.js";
import { createTenantContext } from "../../src/lib/tenant.js";
import { withCalendarLock } from "../../src/modules/calendar/calendar-lock.js";
import { clearTables, createDoctor, createTestPool, resetDatabase } from "./helpers/db.js";

const pool = createTestPool();

beforeAll(async () => {
  await resetDatabase(pool);
});

beforeEach(async () => {
  await clearTables(pool);
});

afterAll(async () => {
  await pool.end();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function tenantFor(): Promise<ReturnType<typeof createTenantContext>> {
  const doctor = await createDoctor(pool);
  return createTenantContext(doctor.doctorId, { kind: "doctor", userId: doctor.user.id });
}

describe("withCalendarLock", () => {
  it("serializa dos operaciones simultáneas del mismo médico", async () => {
    const ctx = await tenantFor();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const firstInside = new Promise<void>((resolve) => (entered = resolve));

    const first = withCalendarLock(ctx, pool, async () => {
      events.push("a-dentro");
      entered();
      await gate;
      events.push("a-fuera");
    });
    await firstInside;
    const second = withCalendarLock(ctx, pool, async () => {
      events.push("b-dentro");
    });
    await sleep(300); // si no hubiera bloqueo, b ya habría entrado
    expect(events).toEqual(["a-dentro"]);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["a-dentro", "a-fuera", "b-dentro"]);
  });

  it("no bloquea entre médicos distintos", async () => {
    const a = await tenantFor();
    const b = await tenantFor();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const firstInside = new Promise<void>((resolve) => (entered = resolve));
    const first = withCalendarLock(a, pool, async () => {
      entered();
      await gate;
    });
    await firstInside;
    const result = await withCalendarLock(b, pool, async () => "listo");
    expect(result).toBe("listo");
    release();
    await first;
  });

  it("revierte todo si el callback lanza", async () => {
    const ctx = await tenantFor();
    await expect(
      withCalendarLock(ctx, pool, async (connection) => {
        await connection.execute(
          "INSERT INTO calendar_settings (doctor_id, updated_at) VALUES (?, UTC_TIMESTAMP(3))",
          [ctx.doctorId],
        );
        throw new Error("falla a propósito");
      }),
    ).rejects.toThrow("falla a propósito");
    const [rows] = await pool.query("SELECT doctor_id FROM calendar_settings");
    expect(rows).toEqual([]);
  });

  it("confirma lo escrito si termina bien", async () => {
    const ctx = await tenantFor();
    await withCalendarLock(ctx, pool, async (connection) => {
      await connection.execute("INSERT INTO calendar_settings (doctor_id, updated_at) VALUES (?, UTC_TIMESTAMP(3))", [ctx.doctorId]);
    });
    const [rows] = await pool.query("SELECT doctor_id FROM calendar_settings");
    expect(rows).toHaveLength(1);
  });

  it("reintenta toda la operación ante un deadlock", async () => {
    const ctx = await tenantFor();
    let attempts = 0;
    const result = await withCalendarLock(ctx, pool, async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("deadlock simulado"), { errno: 1213 });
      return attempts;
    });
    expect(result).toBe(2);
  });

  it("un médico inexistente lanza NotFoundError", async () => {
    const ctx = createTenantContext(999_999, { kind: "doctor", userId: 1 });
    await expect(withCalendarLock(ctx, pool, async () => "no debe llegar")).rejects.toBeInstanceOf(NotFoundError);
  });
});
