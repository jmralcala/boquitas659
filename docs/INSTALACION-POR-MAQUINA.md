# Instalación por máquina (una sola vez)

Esto se hace **una vez por computadora**, no por proyecto. Marca cada casilla al terminar.
Los comandos de instalación de Windows/macOS/uv/Node están escritos de memoria: si alguno falla, usa la página oficial de la herramienta.

## Listado

| ✔ | Qué | Para qué | Cómo verificar |
|---|---|---|---|
| ☐ | **Git** | Control de versiones; Claude Code lo usa para clonar marketplaces | `git --version` |
| ☐ | **Node.js ≥ 20** (con npm) | Stack del proyecto y hooks | `node --version` |
| ☐ | **Python ≥ 3.8** | Lo exige el plugin `security-guidance` | `python --version` |
| ☐ | **uv** | Ejecuta Spec Kit (`uvx`) | `uv --version` |
| ☐ | **Claude Code ≥ 2.1.144** | El asistente | `claude --version` |
| ☐ | **VS Code** + extensión de Claude Code | Tu editor | Extensión visible en VS Code |
| ☐ | **gh** (GitHub CLI) | Crear repos desde la plantilla con un comando (opcional) | `gh --version` |
| ☐ | **Sesión de gh** | Autenticación con GitHub | `gh auth status` |
| ☐ | **Marketplace oficial de plugins** | Catálogo del que se instala el plugin | `claude plugin marketplace list` |
| ☐ | **Plugin `security-guidance`** | Revisión de seguridad en sesión | `claude plugin list` |
| ☐ | **Plantilla marcada como Template** (en GitHub) | Poder usar "Use this template" | Settings → Template repository |

## Comandos (Windows, PowerShell)

Instala en este orden. Cierra y reabre la terminal después de instalar cada herramienta, para que el PATH se actualice.

```powershell
winget install --id Git.Git
winget install --id OpenJS.NodeJS.LTS
winget install --id GitHub.cli --source winget
pip install uv
```
- Si `winget` falla con `0x80072ee7`, es un error de red. Usa `--source winget`, o `winget source reset --force` y `winget source update`. Alternativa: descargar el instalador desde la web oficial de cada herramienta.
- Python: instálalo desde python.org y marca "Add to PATH". En Windows el alias `python3` a veces apunta a la Microsoft Store y no es un Python real; usa `python`.
- `uv` también se puede instalar con otros métodos; consulta la documentación de uv si `pip install uv` no te sirve.
- Claude Code: sigue la instalación oficial de la documentación de Claude Code.

## Sesión de GitHub
```powershell
gh auth login
gh auth status
```
Elige GitHub.com, HTTPS y autenticación por navegador.

## Plugin de seguridad (desde la shell, NO desde Claude Code)

`/plugin install ...` escrito en el panel de la extensión de VS Code responde "isn't available in this environment". Hazlo en PowerShell o Git Bash:

```powershell
claude plugin marketplace add anthropics/claude-plugins-official
claude plugin install security-guidance@claude-plugins-official
```
El marketplace hay que registrarlo **antes**: los comandos `claude plugin` de shell no lo registran solos. Si sale "Plugin not found in marketplace", normalmente es porque falta este paso.

Con alcance de usuario (el predeterminado), el plugin queda disponible en todos tus proyectos y en la terminal, la extensión de VS Code y las sesiones locales de la app de escritorio de esa máquina.

Problemas frecuentes al añadir el marketplace:
- `git not found`: instala Git y abre una terminal nueva.
- Fallo de autenticación SSH: usa la URL HTTPS: `claude plugin marketplace add https://github.com/anthropics/claude-plugins-official.git`
- Timeout al clonar: en PowerShell, `$env:CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS = "300000"` y repite el comando en la misma ventana.

**Primer uso:** el plugin crea su entorno virtual en `~/.claude/security/` e instala el Claude Agent SDK. Necesita internet y puede tardar.

## Una vez en GitHub
1. Sube esta plantilla a un repo propio.
2. Settings → marca **Template repository**.

## Verificación final
```bash
scripts/doctor.sh       # desde Git Bash, dentro de cualquier copia de la plantilla
```
Prueba opcional del plugin: en un repo git de prueba, pide a Claude una función Node que ejecute con `eval` un texto del usuario. Debería aparecer una advertencia de seguridad.

## Lo que NO se instala por máquina
- **Spec Kit:** `new-project.sh` lo ejecuta con `uvx`, fijado a una versión.
- **Context7:** `npx` lo descarga cuando hace falta (versión fijada en `.mcp.json`).
- **CI (gitleaks, `npm audit`, CodeQL):** corre en GitHub.
- **Prettier, ESLint, TypeScript, tests:** son dependencias de cada proyecto (paso 6 del README).
