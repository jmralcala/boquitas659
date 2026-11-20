# Inventario de herramientas

Todo lo de terceros se fija a una versión. Actualiza a propósito, no por accidente.
Criterio usado: versiones con al menos ~2 semanas en circulación.

| Herramienta | Versión fijada | Dónde se fija | Estado de verificación |
|---|---|---|---|
| Spec Kit (`github/spec-kit`) | v1.3.0 | `scripts/new-project.sh` | Probado: `--integration claude`, genera skills `/speckit-*` en `.claude/skills/` |
| Context7 (`@upstash/context7-mcp`) | 4.5.0 | `.mcp.json` | Versión confirmada en npm |
| security-guidance | la de `claude-plugins-official` | Plugin de usuario, una vez por máquina | Instalación verificada en Windows (alcance usuario). Requiere registrar antes el marketplace. Sin probar su comportamiento en la extensión de VS Code |
| `/security-review` | integrado en Claude Code | — | Comando integrado; confirmar que existe en tu versión |
| Skill Inspector | — | `scripts/audit-skills.sh` | **Sin verificar.** El script solo hace heurísticas propias |
| GitHub Actions | tags mayores (v4, v2, v3) | `.github/workflows/` | **Pendiente:** fijar por SHA |

## Instalación del plugin (una vez por máquina, desde la shell)
```
claude plugin marketplace add anthropics/claude-plugins-official
claude plugin install security-guidance@claude-plugins-official
```
`/plugin install ...` escrito en el panel de la extensión de VS Code responde "isn't available in this environment".

## Pendientes
- [ ] Verificar el comando de Skill Inspector e integrarlo en `audit-skills.sh`.
- [ ] Verificar el esquema de `.claude/security-patterns.yaml` en la documentación del plugin.
- [ ] Fijar las GitHub Actions por SHA.
- [ ] Comprobar sintaxis de permisos y hooks contra la documentación vigente de Claude Code.
- [ ] Probar que security-guidance reacciona en la extensión de VS Code.
- [ ] En un proyecto privado con código real, comprobar que CodeQL sube resultados: puede exigir GitHub Advanced Security según el plan (sin verificar).
