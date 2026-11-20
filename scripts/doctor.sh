#!/usr/bin/env bash
# Verifica prerequisitos. No modifica nada. Sale con código 1 si falta algo obligatorio.
set -u

fail=0
ok()   { printf "  ✔ %s\n" "$1"; }
bad()  { printf "  ✘ %s\n" "$1"; fail=1; }
warn() { printf "  ! %s\n" "$1"; }

# ver_ge A B  -> verdadero si A >= B
ver_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; }

echo "Prerrequisitos"
command -v git >/dev/null && ok "git $(git --version | awk '{print $3}')" || bad "git no encontrado"
command -v gh  >/dev/null && ok "gh $(gh --version | head -1 | awk '{print $3}')" || warn "gh no encontrado (opcional, para crear repos desde la plantilla)"

if command -v node >/dev/null; then
  v="$(node --version | sed 's/^v//')"
  ver_ge "$v" "20.0.0" && ok "node $v" || bad "node $v (se requiere >= 20)"
else bad "node no encontrado"; fi

command -v npm >/dev/null && ok "npm $(npm --version)" || bad "npm no encontrado"

# En Windows suele existir "python" y no "python3" (y python3 puede ser un alias de la Store).
PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys' >/dev/null 2>&1; then PY="$c"; break; fi
done
if [ -n "$PY" ]; then
  v="$("$PY" -c 'import sys;print(".".join(map(str,sys.version_info[:3])))')"
  ver_ge "$v" "3.8.0" && ok "$PY $v (security-guidance pide >= 3.8)" || bad "$PY $v (se requiere >= 3.8)"
else bad "python no encontrado (lo necesita security-guidance)"; fi

command -v uv >/dev/null && ok "uv $(uv --version | awk '{print $2}')" || bad "uv no encontrado (necesario para Spec Kit)"

if command -v claude >/dev/null; then
  v="$(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  if [ -n "$v" ]; then
    ver_ge "$v" "2.1.144" && ok "claude code $v" || bad "claude code $v (security-guidance pide >= 2.1.144)"
  else warn "no pude leer la versión de claude"; fi
else bad "claude (Claude Code) no encontrado"; fi

if command -v claude >/dev/null 2>&1; then
  if claude plugin list 2>/dev/null | grep -qi "security-guidance"; then ok "plugin security-guidance instalado"
  else warn "plugin security-guidance no aparece instalado (ver docs/INSTALACION-POR-MAQUINA.md)"; fi
fi

git rev-parse --is-inside-work-tree >/dev/null 2>&1 && ok "dentro de un repo git" || warn "no es un repo git (las revisiones profundas de security-guidance lo requieren)"

echo
[ "$fail" -eq 0 ] && echo "Todo listo." || echo "Faltan prerrequisitos obligatorios."
exit "$fail"
