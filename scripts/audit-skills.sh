#!/usr/bin/env bash
# Revisión básica de higiene de skills (.claude/skills y ~/.claude/skills).
# NO sustituye a Skill Inspector: aquí solo hay heurísticas propias, fáciles de evadir.
# TODO: añadir la invocación de Skill Inspector cuando verifiques su comando en su repo.
set -u
cd "$(dirname "$0")/.."

dirs=(".claude/skills")
[ "${1:-}" = "--global" ] && dirs+=("$HOME/.claude/skills")

# Patrones que merecen una mirada humana (no prueban nada por sí solos).
patterns='curl[^|]*\|[[:space:]]*(ba)?sh|wget[^|]*\|[[:space:]]*(ba)?sh|base64[[:space:]]+(-d|--decode)|eval[[:space:]]*\(|ignore (all )?(previous|prior) instructions|\.ssh/|\.aws/|printenv|process\.env|/etc/passwd'

found=0
for d in "${dirs[@]}"; do
  [ -d "$d" ] || continue
  echo "Revisando $d"
  while IFS= read -r f; do
    # caracteres Unicode invisibles o de dirección (posible ocultamiento)
    if LC_ALL=C grep -nP '\xE2\x80[\x8B-\x8F\xAA-\xAE]|\xE2\x81[\xA0-\xA4]|\xEF\xBB\xBF' "$f" >/dev/null 2>&1; then
      echo "  ! caracteres Unicode invisibles en $f"; found=1
    fi
    if hits="$(grep -nEi "$patterns" "$f" 2>/dev/null)" && [ -n "$hits" ]; then
      echo "  ! patrón sospechoso en $f:"; echo "$hits" | sed 's/^/      /'; found=1
    fi
  done < <(find "$d" -type f \( -name '*.md' -o -name '*.sh' -o -name '*.mjs' -o -name '*.js' -o -name '*.py' \))
done

echo
if [ "$found" -eq 0 ]; then echo "Sin señales. Recuerda: esto no reemplaza una revisión manual ni Skill Inspector."
else echo "Hay señales: revisa cada una a mano antes de confiar en esos skills."; fi
exit "$found"
