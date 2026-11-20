# Proyecto: boquitas659

app web para agendar citas en una clinica dental

## Stack
- Node.js (LTS) + TypeScript
- Gestor de paquetes: npm  <!-- cámbialo si usas pnpm/yarn y ajusta settings.json y hooks -->
- Tests: <vitest|jest>  ·  Lint: ESLint  ·  Formato: Prettier

## Comandos
- `npm run lint` · `npm run typecheck` · `npm run test` · `npm run build` · `npm run format`

## Flujo de trabajo
1. Idea nueva → `grill-me` primero.
2. Proyecto nuevo → `/speckit-constitution`. Feature → `/speckit-specify`, `/speckit-plan`, `/speckit-tasks`, `/speckit-implement`.
3. Para docs de librerías usa Context7 (añade "use context7" al prompt) en lugar de memoria.
4. Antes del PR: `code-review` y `/security-review`.

## Definición de "terminado"
- Compila, pasa lint, typecheck y tests.
- Hay tests para el comportamiento nuevo.
- Sin secretos ni `console.log` de depuración.
- La spec de la feature refleja lo implementado.

## Convenciones
- Valida toda entrada externa en runtime (zod u otro). No confíes solo en tipos.
- Sin `any` salvo justificación en comentario.
- Errores: nunca se tragan; se registran con contexto sin datos sensibles.
- Commits pequeños, mensajes en imperativo.

## Reglas duras
- No edites `.env*`, lockfiles ni `secrets/` (un hook lo bloquea).
- No instales dependencias nuevas sin explicar por qué.
- No ejecutes comandos destructivos ni descargues y ejecutes scripts remotos.

## Más contexto (léelo solo si hace falta)
- Principios de ingeniería: `.specify/memory/constitution.md` (lo crea Spec Kit)
- Modelo de amenazas: `.claude/claude-security-guidance.md`
- Decisiones de arquitectura: `docs/decisions/`
