---
name: code-review
description: Revisión de calidad de código Node/TypeScript antes del PR. Úsalo siempre que el usuario pida "revisa", "code review", "review mi código", "está listo para PR", o cuando termines una implementación y vayas a declararla terminada. Revisa el diff actual, no todo el repo. Para vulnerabilidades usa además /security-review.
allowed-tools: Read, Grep, Glob, Bash(git diff:*), Bash(git status:*), Bash(git log:*)
---

# code-review

Revisa **solo los cambios actuales** (`git diff` contra la rama base). No modifiques archivos: este skill solo reporta.

## Proceso

1. Corre `git status` y `git diff` (y contra la rama base si hay commits).
2. Lee los archivos modificados completos cuando el diff no baste para juzgar.
3. Evalúa contra la lista de abajo y contra `CLAUDE.md`.
4. Reporta en el formato de salida.

## Qué revisar

**Corrección**
- ¿Hace lo que dice la spec/tarea? ¿Hay casos límite sin cubrir (vacío, null, duplicados, concurrencia)?
- Errores async: promesas sin `await`, `catch` que se traga errores, `Promise.all` sin manejo de fallo parcial.

**TypeScript**
- Evita `any`, `as` forzados y `!` sin justificación. Los tipos de entradas externas se validan en runtime (p. ej. con zod), no solo se declaran.

**Pruebas**
- ¿Hay tests nuevos o actualizados para el cambio? ¿Prueban comportamiento y no implementación?

**Diseño y mantenimiento**
- Funciones largas, duplicación, nombres confusos, código muerto, TODOs sin dueño.
- Dependencias nuevas: ¿realmente hacen falta? ¿están mantenidas?

**Señales de seguridad (revisión superficial; lo profundo es de /security-review)**
- Secretos en código o logs, `eval`, `child_process` con entrada de usuario, SQL por concatenación, `innerHTML`.

## Formato de salida

```
## Resumen
<1-2 frases: veredicto general>

## Bloqueantes
- [archivo:línea] problema → sugerencia

## Importantes
- ...

## Menores / estilo
- ...

## Lo que está bien
- <1-3 puntos, para calibrar>
```

Si no hay hallazgos en una sección, escribe "Ninguno". No inventes problemas para llenar el formato.
