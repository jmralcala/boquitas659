# Contrato: textos, destinos y lista de capacidades

Textos en español de México (trato de «tú», como la portada). Son los literales que las pruebas comprueban; cualquier cambio de texto pasa por aquí.

## Barra única (las cuatro páginas)

`<nav aria-label="Principal">`: logo y «Agenda Dental» (→ `/`) · menú: «Inicio» (`/`), «Cómo funciona» (`/como-funciona`), «Planes» (`/planes`), «Nosotros» (`/nosotros`) · acceso: «Registrarme» (`/medicos/registro`) e «Iniciar sesión» con ícono (`/login`). La página actual lleva `aria-current="page"`. Orden de tabulación: logo, menú, «Registrarme», «Iniciar sesión».

## Pie (las cuatro páginas, el de la portada)

«© {año} Agenda Dental» · «Aviso de privacidad» (`/legal/doctor_privacy`) · «Términos y condiciones» (`/legal/terms_doctor`) · «Contacto» (`mailto:` al `RIGHTS_CONTACT_EMAIL`).

## «Cómo funciona» (`/como-funciona`)

- **Título**: «Cómo funciona Agenda Dental». **Descripción**: «Qué es Agenda Dental, sus beneficios y cómo funciona: tu micrositio propio para gestionar las citas de tu consultorio dental.»
- **h1**: «Cómo funciona Agenda Dental». Etiqueta: «Qué es».
- **Qué es**: «Agenda Dental es una solución diseñada y pensada especialmente para la comunidad de odontólogos en México. Mediante una suscripción, cada médico tiene su propio micrositio para llevar la gestión y el seguimiento de sus citas.»
- **Beneficios** (h2 «Beneficios para tu consultorio»; seis tarjetas con ícono):
  1. **Una agenda ordenada** — «Tú defines los horarios, la duración de cada cita, la pausa entre citas, los bloqueos y con cuántos días de anticipación pueden reservar tus pacientes.»
  2. **Sin dobles reservas** — «Tus pacientes solo ven y reservan espacios libres: un paciente por espacio.»
  3. **Menos llamadas** — «Tus pacientes reservan y cancelan sus citas en línea desde el celular, sin llamar al consultorio.»
  4. **Menos inasistencias** — «Cada cita genera un correo de confirmación y un recordatorio, con un enlace para verla o cancelarla.»
  5. **Tu propio micrositio** — «Una página con el nombre, la ubicación (con enlace «Cómo llegar»), el teléfono y el logo de tu consultorio, y un enlace propio para compartir.»
  6. **Orden y privacidad** — «Los datos de tu consultorio y de tus pacientes están separados de los de otros consultorios, y cada paciente acepta el aviso de privacidad con su consentimiento expreso.»
- **Funcionalidades** (h2 «Lo que incluye»; lista con ícono `check`):
  - «Micrositio con enlace propio (`/c/` y el nombre que elijas).»
  - «Calendario por día y por semana.»
  - «Horarios, duración de cita, pausa y bloqueos configurables.»
  - «Anticipación mínima y máxima de reserva, definida por ti.»
  - «Cancelación del paciente hasta 24 horas antes (configurable) y cancelación del médico con aviso al paciente por correo.»
  - «Correos de confirmación y de recordatorio de cada cita.»
  - «Cuentas para tu personal de recepción.»
  - «Datos separados por consultorio.»
  - «Revisión de cada solicitud de médico por nuestro equipo antes de activar la cuenta.»
- **Pasos del médico** (h2 «Para el médico»; lista numerada): 1. «Te registras y nuestro equipo valida tu cédula profesional en el Registro Nacional de Profesionistas y tu identificación oficial.» 2. «Configuras tu calendario y creas tu micrositio.» 3. «Compartes tu enlace con tus pacientes.» 4. «Tus pacientes reservan y reciben avisos por correo.» 5. «Gestionas y das seguimiento a tus citas desde tu agenda.»
- **Pasos del paciente** (h2 «Para el paciente»): 1. «Entra al enlace de su consultorio.» 2. «Elige el día y el horario.» 3. «Recibe la confirmación por correo.» 4. «Puede cancelar su cita desde el enlace, dentro del plazo.»
- **Llamada final**: «Crea la cuenta de tu consultorio. Revisamos cada solicitud antes de activar la cuenta.» Botones: «Regístrate aquí» (`/medicos/registro`) e «Iniciar sesión» (`/login`).

## «Planes» (`/planes`)

- **Título**: «Planes de Agenda Dental». **Descripción**: «Conoce los planes Esencial, Profesional y Élite de Agenda Dental, con 30 % de descuento de lanzamiento.»
- **h1**: «Planes». **Introducción**: «Elige el plan para tu consultorio. Por lanzamiento, todos los planes tienen 30 % de descuento.»
- **Tarjetas** (orden: Esencial, Profesional, Élite). Cada una: nombre; insignia «30 % de descuento»; `<del>` con el precio original precedido de «Precio anterior:» oculto visualmente; precio con descuento destacado precedido de «Precio con descuento:» oculto visualmente; «al mes · IVA incluido»; lista; botón «Regístrate aquí» (`/medicos/registro`).

| Plan | Precio anterior | Precio con descuento | Lista (todas con ícono `check`) |
|---|---|---|---|
| Esencial | `$499` | `$349` | «Prueba de 5 días» · «Micrositio, agenda y reservas de tus pacientes» · «Avisos por correo» · «30 avisos de urgencia por WhatsApp al mes» + insignia «Próximamente» |
| Profesional | `$999` | `$699` | «Sin prueba» · «Micrositio, agenda y reservas de tus pacientes» · «Avisos por correo» · «400 mensajes de WhatsApp al mes» + insignia «Próximamente» |
| Élite | `$1,999` | `$1,399` | «Sin prueba» · «Micrositio, agenda y reservas de tus pacientes» · «Avisos por correo» · «1,200 mensajes de WhatsApp al mes» + insignia «Próximamente» |

- **Notas** (bloque bajo las tarjetas, texto visible):
  1. «Promoción de lanzamiento por tiempo limitado. Precios y condiciones sujetos a cambio.»
  2. «Precios en pesos mexicanos (MXN) por mes, con IVA incluido.»
  3. «Hoy los avisos de Agenda Dental salen por correo. Los avisos por WhatsApp estarán disponibles próximamente.»
  4. «Durante el piloto no se realiza ningún cobro. El cobro se activará más adelante y se te avisará con anticipación.»

## «Nosotros» (`/nosotros`)

- **Título**: «Nosotros | Agenda Dental». **Descripción**: «Agenda Dental es un producto desarrollado por Innvend Works, empresa de software, datos e inteligencia artificial para empresas.»
- **h1**: «Nosotros». **Texto principal**: «Agenda Dental es un producto desarrollado por Innvend Works.» con el enlace «www.innvend.com» (`https://www.innvend.com`, `target="_blank"`, `rel="noopener noreferrer"`).
- **Quiénes son** (h2 «Innvend Works»): «Software, datos e IA para empresas. Innvend ayuda a las empresas a operar mejor mediante software, datos e inteligencia artificial. Combina consultoría, desarrollo de software a medida y productos propios, y tiene más de 20 años de experiencia, según su sitio.»
- **Contacto de Innvend** (h2 «Contacto de Innvend Works»): «Correo: `contacto@innvend.com` (`mailto:`) · Teléfono: `(52) 33 1241 5547` (`tel:+523312415547`).» Aclaración: «Este es el contacto de la empresa que desarrolla Agenda Dental; el enlace «Contacto» del pie es el de Agenda Dental.»
- No aparecen: dirección, redes sociales, nombres de personas, clientes ni cifras que el sitio de Innvend no muestre.

## Lista de capacidades del piloto (contra la que se verifica «Cómo funciona»)

Micrositio `/c/nombre` con nombre, ubicación («Cómo llegar»), teléfono y logo opcional; agenda por día y semana; horarios, duración, pausa, bloqueos y anticipación mínima y máxima configurables; reserva sin dobles reservas; cancelación del paciente (24 h, configurable) y del médico con aviso por correo; correos de confirmación y recordatorio con enlace; personal de recepción; separación de datos por consultorio; aviso de privacidad con consentimiento expreso; revisión de cada solicitud de médico por soporte (cédula e identificación oficial).

## Términos prohibidos (se comprueban por página, sin acentos y en minúsculas)

- **Todas las páginas**: `reprogram`, `rentabil`, `ganancia`, `ingreso`, `garant`, `satisfech`, `testimonio`, `lider`, `#1`, `mensajer`, `pasarela`, `openpay`, «1 peso», «excedent», «exceso».
- **«Cómo funciona» y «Nosotros»**: además `whatsapp`, `precio`, `costo`, `gratis`, `descuento`, `oferta`, `urgencia`, `%`.
- **«Planes»**: `whatsapp` solo dentro de un elemento marcado «Próximamente» (o la nota 3); `%` solo como «30 %»; sin `gratis` ni `oferta`.
- **Portada**: la lista de la feature 7 (el menú de la barra no cuenta: lleva «Planes»).
