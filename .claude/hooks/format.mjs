#!/usr/bin/env node
// PostToolUse: formatea con Prettier el archivo editado. Nunca bloquea (siempre exit 0).
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

let input = {};
try { input = JSON.parse(readFileSync(0, "utf8")); } catch { process.exit(0); }

const file = input?.tool_input?.file_path;
if (!file || !existsSync(file)) process.exit(0);
if (!/\.(ts|tsx|js|jsx|mjs|cjs|json|md|css|yml|yaml)$/.test(file)) process.exit(0);

// --no-install: si el proyecto no tiene prettier, no descarga nada.
spawnSync("npx", ["--no-install", "prettier", "--write", file], { stdio: "ignore" });
process.exit(0);
