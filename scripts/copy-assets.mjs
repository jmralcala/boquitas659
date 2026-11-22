// Copia a `dist/` los archivos que `tsc` no emite (por ejemplo la lista de contraseñas comunes).
import { cpSync } from "node:fs";

const assets = [["src/modules/auth/data", "dist/src/modules/auth/data"]];

for (const [from, to] of assets) {
  cpSync(from, to, { recursive: true });
}
