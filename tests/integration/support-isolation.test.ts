import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestPool, resetDatabase } from "./helpers/db.js";
import { createTestApp, type TestApp } from "./helpers/app.js";

// El panel de soporte no es un tenant: no usa el contexto de médico y por eso no puede tocar datos de pacientes.
const pool = createTestPool();
let t: TestApp;
const registered: { method: string; url: string }[] = [];

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool, {}, {
    onRoute: (route) => {
      for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
        if (method !== "HEAD" && method !== "OPTIONS") registered.push({ method, url: route.url });
      }
    },
  });
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

const SUPPORT_DIR = "src/modules/support";
const sourceFiles = (): string[] => readdirSync(SUPPORT_DIR).filter((name) => name.endsWith(".ts")).map((name) => join(SUPPORT_DIR, name));

// Quita comentarios para no confundir una explicación con una consulta.
function code(file: string): string {
  return readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("soporte no ve datos de pacientes ni el contenido de los correos", () => {
  it("hay archivos del módulo que revisar", () => {
    expect(sourceFiles().length).toBeGreaterThanOrEqual(5);
  });

  it("ningún archivo de soporte consulta tablas de pacientes ni sus columnas de nombre, correo o teléfono", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const text = code(file);
      // Tablas de pacientes y de sus autorizaciones.
      if (/\b(FROM|JOIN|UPDATE|INTO)\s+`?(patient|patient_account|doctor_patient|data_authorization)\b/i.test(text)) offenders.push(`${file}: tabla de pacientes`);
      if (/\bpatient_(name|email|phone)\b|\bfull_name\b[^\n]*\bpatient/i.test(text)) offenders.push(`${file}: columna de paciente`);
      // Contenido de la cola de envío y categoría de urgencia.
      if (/payload_ref/.test(text)) offenders.push(`${file}: payload_ref`);
      if (/\bcategory\b|\bcategoria\b/i.test(text)) offenders.push(`${file}: categoría`);
      // Funciones de lectura de pacientes de otros módulos.
      if (/patient-repository|account-appointments|patient-appointments/.test(text)) offenders.push(`${file}: importa lecturas de pacientes`);
    }
    expect(offenders).toEqual([]);
  });

  it("las citas solo se cuentan: la única consulta a appointment es COUNT(*) filtrada por médico", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      for (const match of code(file).matchAll(/SELECT((?:(?!SELECT)[\s\S])*?)FROM\s+`?appointment\b/gi)) {
        if (!/^\s*COUNT\(\*\)/i.test(match[1] ?? "")) offenders.push(`${file}: ${(match[1] ?? "").trim().slice(0, 40)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no recibe un contexto de médico (soporte no es un tenant)", () => {
    for (const file of sourceFiles()) {
      expect(code(file), file).not.toMatch(/TenantContext|StaffContext|createTenantContext|createPatientContext/);
    }
  });
});

describe("sin impersonación ni rutas que modifiquen el historial", () => {
  const supportRoutes = () => registered.filter((route) => route.url.startsWith("/soporte"));

  it("ninguna ruta de soporte crea, rota o cambia una sesión", () => {
    for (const file of sourceFiles()) {
      expect(code(file), file).not.toMatch(/sessions\.(create|rotate|setActiveDoctor)|createSession|impersonat|loginAs/i);
    }
  });

  it("solo hay rutas GET y POST bajo /soporte (ningún PUT, PATCH ni DELETE)", () => {
    expect(supportRoutes().length).toBeGreaterThanOrEqual(3);
    expect(supportRoutes().filter((route) => !["GET", "POST"].includes(route.method))).toEqual([]);
  });

  it("ninguna ruta del panel acepta cambiar una cuenta de soporte: el id se resuelve contra doctor", () => {
    const source = code("src/modules/support/account-state-service.ts");
    expect(source).toMatch(/findDoctorById/);
    expect(source).not.toMatch(/FROM\s+`user`/i);
  });
});
