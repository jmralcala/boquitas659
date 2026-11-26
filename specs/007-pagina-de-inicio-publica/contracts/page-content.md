# Contrato: contenido de la portada

Textos definitivos (español de México, decisión de la persona responsable del 26/11/2026: opción A, texto veraz). Un cambio de texto se revisa contra la **lista de capacidades** y la **lista de términos prohibidos** de abajo.

## Textos

| Bloque | Texto |
|---|---|
| `<title>` | Agenda Dental: agenda en línea para consultorios dentales |
| Descripción (`meta name="description"`) | Agenda en línea para consultorios dentales: tus pacientes reservan y cancelan sus citas desde el celular y tú ves toda tu agenda en un solo lugar. |
| Etiqueta | Agenda en línea para consultorios dentales |
| `h1` (dos líneas) | **Tu consultorio, en orden.** / *Tus pacientes, a un mensaje de distancia.* (la segunda en el color primario) |
| Párrafo principal | Tus pacientes prefieren agendar como hacen todo lo demás: desde su celular, en segundos y sin llamadas. **Agenda Dental** les permite reservar y cancelar sus citas en línea y recibir avisos por correo, mientras tú tienes toda tu agenda bajo control. |
| Botones principales | Regístrate aquí · Ya tengo cuenta |
| `h2` de beneficios | La agenda es el punto de partida de un consultorio que funciona bien. |
| Introducción | Con ella bien gestionada puedes: |
| Tarjeta 1 | Planear con certeza tu semana, con los horarios, la duración de cita y los bloqueos que tú eliges. |
| Tarjeta 2 | Aprovechar al máximo cada consulta: tus pacientes solo reservan espacios libres, sin dobles reservas. |
| Tarjeta 3 | Cumplir los tiempos de cada consulta con la duración y la pausa que tú configuras. |
| Tarjeta 4 | Reducir las inasistencias con recordatorios por correo. |
| Tarjeta 5 | Mantener tu agenda y los datos de tus pacientes separados de los de otros consultorios. |
| `h2` de la banda | Menos llamadas y una agenda más ordenada. |
| Texto de la banda | Crea la cuenta de tu consultorio y empieza a recibir citas en línea. Revisamos cada solicitud antes de activar la cuenta. |
| Botón de la banda | Regístrate aquí |
| Pie | © {año} Agenda Dental · Aviso de privacidad · Términos y condiciones · Contacto |

Destinos: ver [data-model.md](../data-model.md).

## Lista de capacidades del piloto (lo que la portada puede afirmar)

Reservar y cancelar citas en línea · avisos y recordatorios por correo · agenda por día y semana · horarios de atención, duración de cita, pausa y bloqueos configurables · micrositio propio con enlace · personal de recepción · sin dobles reservas · datos separados por consultorio · cada solicitud de médico la revisa soporte.

## Términos prohibidos (la prueba falla si aparecen en el texto visible)

`reprogram`, `whatsapp`, `mensajer`, `rentabil`, `ganancia`, `ingreso`, `precio`, `costo`, `gratis`, `plan` y `planes` **como palabra completa** (para no rechazar «planear»), `descuento`, `oferta`, `garant`, `satisfech`, `testimonio`, `#1`, `líder`, y cualquier cifra de resultados (por ejemplo «%» o «x veces»). Las urgencias en línea tampoco se mencionan (dependen de la validación de un dentista).

## Accesibilidad de la estructura

Un solo `h1`; regiones `header`, `main#contenido` y `footer`; «Saltar al contenido» como primer elemento; íconos `aria-hidden`; los dos «Regístrate aquí» comparten nombre y destino; ningún enlace se llama solo «aquí» (el nombre accesible incluye «Regístrate»); contraste ≥ 4.5:1 con los tokens existentes.
