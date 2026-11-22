import { defineConfig } from "vitest/config";

// Las pruebas de integración y de contrato necesitan una MariaDB real (TEST_DATABASE_URL).
// Sin esa variable se omiten con un aviso, para que `npm run test` siga útil en cualquier máquina.
const hasTestDb = Boolean(process.env.TEST_DATABASE_URL);

if (!hasTestDb) {
  // Aviso intencional de configuración (no es un log de depuración).
  process.stdout.write(
    "[vitest] TEST_DATABASE_URL no está definida: se omiten tests/integration y tests/contract.\n",
  );
}

export default defineConfig({
  test: {
    passWithNoTests: true,
    include: hasTestDb
      ? ["tests/**/*.test.ts", "src/**/*.test.ts"]
      : ["tests/unit/**/*.test.ts", "src/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 20000,
  },
});
