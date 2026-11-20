#!/usr/bin/env node
// PreToolUse: bloquea ediciones a archivos sensibles. Exit 2 = bloquear y avisar a Claude.
import { readFileSync } from "node:fs";

let input = {};
try { input = JSON.parse(readFileSync(0, "utf8")); } catch { process.exit(0); }

const file = String(input?.tool_input?.file_path ?? "").replace(/\\/g, "/");
if (!file) process.exit(0);

const blocked = [
  /(^|\/)\.env(\..*)?$/,              // .env, .env.local, .env.production (permite .env.example abajo)
  /(^|\/)package-lock\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)\.git\//,
  /(^|\/)secrets\//,
  /\.(pem|key|p12|pfx)$/,
];
const allowed = [/(^|\/)\.env\.example$/];

if (!allowed.some((r) => r.test(file)) && blocked.some((r) => r.test(file))) {
  console.error(`Bloqueado por política del proyecto: "${file}" no se edita desde Claude. Pide al usuario que lo haga a mano.`);
  process.exit(2);
}
process.exit(0);
