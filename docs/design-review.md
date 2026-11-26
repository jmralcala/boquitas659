# Revisión visual del diseño (feature 6, T046)

Verificación **manual** (el proyecto no tiene navegador automatizado). Repetir a **1440 px** y a **390 px**, con el teclado y con «reducir movimiento». No guardar capturas con datos reales de pacientes.

Estado: **pendiente de la revisión manual** (las pruebas automáticas cubren estructura, contraste, etiquetas, un solo `h1`, tablas envueltas y la ausencia de recursos externos).

| Tipo | Pantalla ejemplar | 1440 px | 390 px | Teclado | Notas |
|---|---|---|---|---|---|
| Acceso | `/login`, `/recuperar` | ☐ | ☐ | ☐ | |
| Registro y legales | `/pacientes/registro`, `/legal`, `/derechos` | ☐ | ☐ | ☐ | |
| Públicas del consultorio | `/c/<slug>`, `/c/<slug>/entrar` | ☐ | ☐ | ☐ | |
| Reserva | `/c/<slug>/reservar?fecha=…` (días y horarios táctiles) | ☐ | ☐ | ☐ | |
| Urgencias | `/c/<slug>/urgencia` y la pantalla de alarma | ☐ | ☐ | ☐ | La instrucción de hospital es lo más destacado |
| Paciente | `/pacientes/citas`, detalle, `/pacientes/consultorios` | ☐ | ☐ | ☐ | |
| Médico | `/agenda/dia/…`, nueva cita, detalle, bloqueos, configuración, mi micrositio | ☐ | ☐ | ☐ | |
| Recepción | panel y agenda (sin «Configuración») | ☐ | ☐ | ☐ | |
| Soporte | médicos, detalle, micrositios, correos, métricas, historial | ☐ | ☐ | ☐ | Tablas con scroll interno |
| Errores | `/ruta-que-no-existe`, formulario vencido | ☐ | ☐ | ☐ | |

Comprobar además: foco visible en cada control; «Saltar al contenido» con Tab; sin desplazamiento horizontal de la página; botones y campos de al menos 44 px; ninguna petición fuera de `agendadental.innvend.com` (salvo Turnstile).
