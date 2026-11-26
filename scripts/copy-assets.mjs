// Copia a `dist/` los archivos que `tsc` no emite (por ejemplo la lista de contraseñas comunes).
import { cpSync } from "node:fs";

const assets = [
  ["src/modules/auth/data", "dist/src/modules/auth/data"],
  // Hoja de estilos y fuentes propias del diseño (se sirven desde /assets).
  ["src/http/assets", "dist/src/http/assets"],
];

for (const [from, to] of assets) {
  cpSync(from, to, { recursive: true });
}
