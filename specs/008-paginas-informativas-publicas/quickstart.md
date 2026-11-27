# Quickstart: validar las páginas informativas

Prerrequisitos: `npm ci`; base de pruebas configurada (`TEST_DATABASE_URL`); correr vitest por PowerShell con `C:\…`.

## 1. Automático

```powershell
npm run lint
npm run typecheck
npx vitest run tests/unit/plans.test.ts tests/unit/info-copy.test.ts tests/unit/landing-copy.test.ts tests/contract/info-pages.test.ts tests/contract/landing.test.ts tests/integration/route-audit.test.ts tests/contract/design-shell.test.ts tests/contract/design-a11y.test.ts tests/unit/design-guards.test.ts
npx vitest run     # suite completa, una sola ejecución a la vez
```

Esperado: todo verde. Las pruebas cubren SC-001 a SC-009 salvo lo visual (punto 3).

## 2. Local (`npm run dev`)

1. Abrir `/`, `/como-funciona`, `/planes` y `/nosotros` sin sesión: misma barra en las cuatro; solo la actual marcada. (SC-001)
2. En «Planes» comprobar los seis montos: `$499`→`$349`, `$999`→`$699`, `$1,999`→`$1,399`, las insignias «Próximamente», la promoción y la nota del cobro. (SC-004)
3. En «Nosotros» abrir `www.innvend.com`: se abre en otra pestaña; correo y teléfono visibles.
4. Iniciar sesión con cada rol y abrir las tres páginas: 200 sin redirección; con un aviso legal pendiente o soporte sin segundo factor, también. (SC-009)
5. Ver el código fuente: ningún `<form>`, `<script>`, `style=` ni dirección externa salvo `www.innvend.com`. (SC-006)

## 3. Manual (producción tras el despliegue)

- 390 px y 1440 px en las cuatro páginas: sin desplazamiento horizontal, la barra se acomoda, botones ≥ 44 px, tarjetas de plan apiladas en celular. (SC-005)
- Teclado: Tab recorre logo → menú → «Registrarme» → «Iniciar sesión» → contenido, foco visible. (SC-008)
- Lector de pantalla: el precio tachado se lee como «Precio anterior», el nuevo como «Precio con descuento».
- Cabeceras: `curl -sI https://agendadental.innvend.com/planes` → 200, `cache-control: no-store`, sin `set-cookie`.
- Pendiente de negocio (no bloquea el despliegue): Jurídico y Contabilidad validan precios, descuento, topes y la aclaración del cobro (paquete legal).
