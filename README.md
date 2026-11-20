# project-template (Node + Claude Code)

Plantilla base para proyectos Node/TypeScript con Claude Code en VS Code: flujo spec-driven y seguridad en capas.

> **Primero, una vez por máquina:** instala lo de [`docs/INSTALACION-POR-MAQUINA.md`](docs/INSTALACION-POR-MAQUINA.md).
> Después, cada proyecto nuevo sigue los pasos de abajo.

---

## Pasos por cada proyecto nuevo

Los scripts son bash: en Windows, ejecútalos desde **Git Bash** (o WSL), no desde PowerShell.

### 1. Crear el repositorio desde la plantilla
Con `gh`:
```bash
gh repo create mi-proyecto --template <tu-usuario>/project-template --clone
cd mi-proyecto
```
Sin `gh`: en GitHub, botón **Use this template** → **Create a new repository**, y luego `git clone` del repo nuevo. No hagas `git clone` de la plantilla: arrastraría su historial y su remoto.

### 2. Abrir en VS Code
```bash
code .
```
Acepta instalar las extensiones recomendadas (`.vscode/extensions.json`). Abre la terminal integrada en **Git Bash**.

### 3. Verificar prerrequisitos
```bash
scripts/doctor.sh
```
Debe terminar en "Todo listo". Si marca algo obligatorio en rojo, resuélvelo con `docs/INSTALACION-POR-MAQUINA.md`.

### 4. Inicializar el proyecto
```bash
scripts/new-project.sh --dry-run    # muestra qué hará, sin cambiar nada
scripts/new-project.sh              # lo ejecuta
```
Hace: `git init` si falta, `specify init` con Spec Kit fijado (genera `.specify/` y los skills `/speckit-*` en `.claude/skills/`) y la auditoría básica de skills. Se puede correr dos veces sin romper nada.

### 5. Rellenar los marcadores de la plantilla
- `CLAUDE.md`: reemplaza `<NOMBRE>`, la descripción y el stack real (gestor de paquetes y runner de tests).
- `SECURITY.md`: reemplaza `<TU-CORREO>`.
- `.claude/claude-security-guidance.md`: añade al final las reglas propias del proyecto (sección "Reglas propias").

### 6. Crear `package.json` y dependencias
La plantilla no los incluye. Ejemplo mínimo, ajústalo a tu stack:
```bash
npm init -y
npm i -D typescript prettier eslint vitest @types/node
npm init @eslint/config        # crea la configuración de ESLint
npx tsc --init                 # crea tsconfig.json
```
Define en `package.json` los scripts que usan `CLAUDE.md` y el CI: `lint`, `typecheck`, `test`, `build` y `format`.
**Prettier debe quedar como dependencia del proyecto:** el hook de formato usa `--no-install` y, si no lo encuentra, no formatea y no avisa.

### 7. Primer commit y subida
```bash
git add -A
git commit -m "Inicializa proyecto desde plantilla"
git push -u origin main
```
Confirma que el CI (`.github/workflows/`) corre en verde. Si tu plan lo permite, activa en los ajustes del repo el *push protection* de secretos y Dependabot (depende del tipo de repo y plan; no verificado).

### 8. Abrir Claude Code y comprobar el entorno
En la raíz del proyecto abre Claude Code (terminal con `claude`, o la extensión de VS Code).
- La primera vez puede pedirte aprobar el servidor MCP de proyecto (Context7, de `.mcp.json`). Revisa que sea el esperado y apruébalo.
- Escribe `/plugin` solo y confirma que `security-guidance` aparece instalado y habilitado.

### 9. Trabajar con el flujo
1. `grill-me` para afinar la idea.
2. Proyecto nuevo: `/speckit-constitution`.
3. Por cada feature: `/speckit-specify` → `/speckit-plan` → `/speckit-tasks` → `/speckit-implement`.
4. Para documentación de librerías usa Context7 (añade "use context7" al prompt).

### 10. Antes de cada PR
1. `code-review` sobre el diff.
2. `/security-review`.
3. `npm run lint && npm run typecheck && npm run test`.
4. Revisa que la spec de la feature refleje lo implementado.

---

## Seguridad en capas
- **En sesión:** plugin `security-guidance` + hooks (`protect.mjs` bloquea `.env`, lockfiles y claves).
- **Bajo demanda:** `/security-review`.
- **CI:** gitleaks, `npm audit`, CodeQL.

`security-guidance` solo revisa lo que escribe Claude, no lo que haces tú a mano; para eso está el CI.

## Si algo falla
- `/plugin install ...` responde "isn't available in this environment": los plugins se instalan desde la shell, no desde el panel de VS Code (ver `docs/INSTALACION-POR-MAQUINA.md`).
- `specify init` falla o cambió de flags: revisa `specify init --help` con la versión fijada en `scripts/new-project.sh`.
- El hook de formato no hace nada: falta Prettier en el proyecto (paso 6).

## Qué contiene la plantilla
Ver `TOOLS.md` (versiones y pendientes de verificación) y `CHANGELOG.md`.

## Versión de la plantilla
`.template-version`. Los proyectos creados no se actualizan solos: compara su `.template-version` con la de la plantilla.
