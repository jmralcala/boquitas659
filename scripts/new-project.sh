#!/usr/bin/env bash
# Inicializa un proyecto recién creado desde la plantilla. Idempotente.
# Uso: scripts/new-project.sh [--dry-run]
set -euo pipefail

# Versión de Spec Kit fijada (revisa y actualiza a propósito; ver TOOLS.md).
SPEC_KIT_VERSION="v1.3.0"
SPEC_KIT_REPO="git+https://github.com/github/spec-kit.git@${SPEC_KIT_VERSION}"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

run() {
  if [ "$DRY_RUN" -eq 1 ]; then echo "[dry-run] $*"; else echo "+ $*"; "$@"; fi
}

cd "$(dirname "$0")/.."

echo "== 1/4 Prerrequisitos =="
bash scripts/doctor.sh || { echo "Corrige lo anterior y vuelve a ejecutar."; exit 1; }

echo
echo "== 2/4 Repositorio git =="
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Ya es un repo git."
else
  run git init
fi

echo
echo "== 3/4 Spec Kit ${SPEC_KIT_VERSION} =="
if [ -f .specify/init-options.json ]; then
  echo "Spec Kit ya está inicializado (.specify/ existe). Se omite."
else
  # --force: la carpeta ya tiene archivos de la plantilla. --non-interactive: sin prompts.
  run uvx --from "$SPEC_KIT_REPO" specify init --here --force --non-interactive --integration claude
fi

echo
echo "== 4/4 Auditoría de skills =="
run bash scripts/audit-skills.sh

echo
if command -v claude >/dev/null 2>&1 && claude plugin list 2>/dev/null | grep -qi "security-guidance"; then
  echo "Plugin security-guidance: ya instalado en esta máquina."
else
  cat <<'MSG'
Plugin security-guidance: no detectado. Se instala UNA VEZ por máquina, desde la shell
(no dentro de Claude Code ni del panel de VS Code):

  claude plugin marketplace add anthropics/claude-plugins-official
  claude plugin install security-guidance@claude-plugins-official

MSG
fi
echo "Siguiente: rellena CLAUDE.md, corre \`grill-me\` y luego /speckit-constitution."
