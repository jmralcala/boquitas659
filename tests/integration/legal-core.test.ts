import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFixedClock, type FixedClock } from "../../src/lib/clock.js";
import { createLegalService, type LegalService } from "../../src/modules/legal/legal-service.js";
import { seedProvisionalDocuments } from "../../src/modules/legal/seed-provisional.js";
import { clearTables, createTestPool, createUser, resetDatabase } from "./helpers/db.js";

const pool = createTestPool();

let clock: FixedClock;
let legal: LegalService;

beforeAll(async () => {
  await resetDatabase(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  clock = createFixedClock(new Date("2026-06-01T10:00:00.000Z"));
  legal = createLegalService(pool, clock);
});

afterAll(async () => {
  await pool.end();
});

describe("LegalService", () => {
  it("publica versiones consecutivas por tipo y devuelve la última", async () => {
    const v1 = await legal.publish({ type: "patient_privacy", title: "Aviso", body: "uno", isProvisional: true });
    const v2 = await legal.publish({ type: "patient_privacy", title: "Aviso", body: "dos", isProvisional: false });
    const other = await legal.publish({ type: "terms_doctor", title: "Términos", body: "t", isProvisional: true });

    expect([v1.version, v2.version, other.version]).toEqual([1, 2, 1]);
    expect(await legal.latest("patient_privacy")).toMatchObject({ version: 2, body: "dos", isProvisional: false });
    expect(await legal.latest("reception_privacy")).toBeNull();
  });

  it("publicar versiones simultáneas no repite números de versión", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        legal.publish({ type: "doctor_privacy", title: "Aviso", body: `texto ${i}`, isProvisional: true }),
      ),
    );
    expect(results.map((r) => r.version).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("registra la aceptación con quién, documento, versión y cuándo", async () => {
    const user = await createUser(pool);
    const doc = await legal.publish({ type: "patient_privacy", title: "Aviso", body: "x", isProvisional: true });
    await legal.recordAcceptance({ userId: user.id, documentId: doc.id });

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT c.user_id, c.accepted_at, d.type, d.version FROM consent_acceptance c
         JOIN legal_document d ON d.id = c.legal_document_id`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: user.id, type: "patient_privacy", version: 1 });
    expect((rows[0]?.accepted_at as Date).toISOString()).toBe("2026-06-01T10:00:00.000Z");
  });

  it("UPDATE y DELETE sobre consent_acceptance fallan (solo anexar)", async () => {
    const user = await createUser(pool);
    const doc = await legal.publish({ type: "patient_privacy", title: "Aviso", body: "x", isProvisional: true });
    await legal.recordAcceptance({ userId: user.id, documentId: doc.id });

    await expect(pool.execute("UPDATE consent_acceptance SET accepted_at = UTC_TIMESTAMP(3)")).rejects.toThrow(
      /solo anexar/,
    );
    await expect(pool.execute("DELETE FROM consent_acceptance")).rejects.toThrow(/solo anexar/);
    const [rows] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM consent_acceptance");
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it("pendingFor lista los documentos aplicables cuya última versión no se ha aceptado", async () => {
    const user = await createUser(pool, { role: "doctor" });
    await seedProvisionalDocuments(legal);

    expect((await legal.pendingFor(user.id, "doctor")).map((d) => d.type).sort()).toEqual([
      "doctor_privacy",
      "terms_doctor",
    ]);

    for (const doc of await legal.pendingFor(user.id, "doctor")) {
      await legal.recordAcceptance({ userId: user.id, documentId: doc.id });
    }
    expect(await legal.pendingFor(user.id, "doctor")).toEqual([]);

    // Una versión nueva obliga a aceptar de nuevo solo ese documento.
    await legal.publish({ type: "terms_doctor", title: "Términos", body: "v2", isProvisional: true });
    expect((await legal.pendingFor(user.id, "doctor")).map((d) => d.type)).toEqual(["terms_doctor"]);
  });

  it("los documentos aplicables dependen del rol", () => {
    expect(legal.applicableTypes("patient")).toEqual(["patient_privacy"]);
    expect([...legal.applicableTypes("doctor")].sort()).toEqual(["doctor_privacy", "terms_doctor"]);
    expect([...legal.applicableTypes("reception")].sort()).toEqual(["reception_confidentiality", "reception_privacy"]);
    expect(legal.applicableTypes("support")).toEqual([]);
  });

  it("el sembrado de textos provisionales es idempotente y los marca como provisionales", async () => {
    await seedProvisionalDocuments(legal);
    await seedProvisionalDocuments(legal);
    const [rows] = await pool.query<RowDataPacket[]>("SELECT type, version, is_provisional FROM legal_document");
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.version === 1 && row.is_provisional === 1)).toBe(true);
  });
});
