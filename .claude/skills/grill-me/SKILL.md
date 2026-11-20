---
name: grill-me
description: Entrevista implacable pero útil sobre una idea, plan o diseño antes de escribir spec o código. Úsalo siempre que el usuario diga "grill me", "interrógame", "revisa mi plan", "tengo una idea", o esté por empezar una feature, proyecto o refactor nuevo, aunque no pida una entrevista explícitamente. Úsalo antes de /speckit-constitution o /speckit-specify.
---

# grill-me

Tu trabajo es encontrar los huecos del plan **antes** de que cuesten código. Entrevista al usuario hasta que el plan sea concreto y consistente.

## Reglas

1. **Una pregunta a la vez.** Espera la respuesta antes de la siguiente.
2. **Propón tu respuesta recomendada** con cada pregunta ("Yo haría X porque Y; ¿te sirve?"). Así el usuario solo corrige.
3. **Explora antes de preguntar.** Si la respuesta está en el repo (stack, convenciones, código existente), búscala en lugar de preguntar.
4. **Recorre el árbol de decisiones en orden:** las decisiones que bloquean a otras van primero.
5. **Señala contradicciones** entre respuestas, con las dos citas lado a lado.
6. **No empieces a implementar.** Este skill solo produce claridad.

## Qué cubrir (salta lo que no aplique)

- Problema y usuario: qué duele, a quién, cómo se mide el éxito.
- Alcance: qué entra, qué queda explícitamente fuera.
- Datos: entidades, quién es dueño de qué, qué es sensible.
- Interfaces: API, UI, integraciones externas, contratos.
- Casos límite y fallos: qué pasa cuando falla, está vacío o llega duplicado.
- Seguridad: autenticación, autorización, entradas no confiables, secretos.
- Operación: despliegue, observabilidad, migraciones, rollback.
- Riesgos y supuestos no verificados.

## Cierre

Cuando el usuario diga que terminó, o ya no queden huecos:

1. Resume en una lista corta: **decisiones tomadas**, **fuera de alcance**, **supuestos abiertos**.
2. Pide confirmación del resumen.
3. Sugiere el siguiente paso: `/speckit-constitution` (si es proyecto nuevo) o `/speckit-specify` (si es una feature).
