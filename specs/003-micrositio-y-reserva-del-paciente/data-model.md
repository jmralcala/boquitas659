# Data Model: Micrositio del médico y reserva del paciente

Migración `0011_site.sql`. Compatible con MySQL 8 y MariaDB, horas en UTC (`DATETIME(3)`), sin tipo JSON, sin campos
clínicos ni de triaje (principio I). Tablas existentes que se usan: `doctor`, `user`, `patient_account`, `patient`,
`doctor_patient`, `appointment`, `calendar_settings`, `calendar_action_log`, `one_time_token`, `legal_document` y
`email_outbox` (features 1 y 2).

## Tablas nuevas

### doctor_site
Una fila por médico, creada cuando elige el nombre de su enlace.

| Campo | Tipo | Regla |
|-------|------|-------|
| `doctor_id` | BIGINT UNSIGNED PK, FK `doctor` | Un micrositio por médico |
| `slug` | VARCHAR(40) NOT NULL, **UNIQUE** | 3 a 40 caracteres, `^[a-z0-9]+(-[a-z0-9]+)*$`; se escribe una sola vez; CHECK de longitud 3–40 |
| `address` | VARCHAR(300) NULL | Texto libre, hasta 300 caracteres |
| `logo_file` | VARCHAR(64) NULL | Nombre aleatorio `^[a-f0-9]{32}\.(png\|jpg\|webp)$` en el directorio de logos |
| `status` | ENUM('draft','published','unpublished') | Por defecto `draft` |
| `first_published_at` | DATETIME(3) NULL | Se fija la primera vez que se publica; distingue «nunca publicado» (404) de «despublicado» (aviso) |
| `published_at` | DATETIME(3) NULL | Última publicación |
| `created_at` / `updated_at` | DATETIME(3) | |

Reglas: para pasar a `published` el médico debe estar `approved`, tener `address`, teléfono del consultorio
(`doctor.office_phone`) y al menos una franja en `calendar_hours`. Cambiar `slug` solo lo hace soporte (procedimiento
manual); no hay regeneración.

### data_authorization (solo anexar)
Constancia de que una cuenta autoriza compartir los datos de contacto de sus pacientes con un consultorio.

| Campo | Tipo | Regla |
|-------|------|-------|
| `id` | BIGINT UNSIGNED PK | |
| `account_id` | BIGINT UNSIGNED FK `patient_account` | La unidad de consentimiento es la cuenta |
| `doctor_id` | BIGINT UNSIGNED FK `doctor` | |
| `given_by_user_id` | BIGINT UNSIGNED FK `user` | Quién marcó la casilla (titular o tutor) |
| `legal_document_id` | BIGINT UNSIGNED FK `legal_document` | Versión del aviso de privacidad vigente al autorizar |
| `accepted_at` | DATETIME(3) | |

Índice `(account_id, doctor_id, accepted_at)`. Disparadores `BEFORE UPDATE` y `BEFORE DELETE` de una sola sentencia
(`SIGNAL SQLSTATE '45000'`), igual que `consent_acceptance`. Una autorización está **activa** si existe una y no hay
una revocación posterior (`doctor_patient.revoked_at` mayor que su fecha).

## Columnas nuevas en tablas existentes

| Tabla | Columna | Tipo y regla |
|-------|---------|--------------|
| `doctor_patient` | `origin` | ENUM('patient','office') NOT NULL, por defecto `office`: quién creó el vínculo |
| `doctor_patient` | `created_by_user_id` | BIGINT UNSIGNED NULL, FK `user` |
| `doctor_patient` | `revoked_at` | DATETIME(3) NULL: vínculo revocado por el paciente (el consultorio ya no ve su contacto) |
| `calendar_settings` | `cancel_notice_hours` | SMALLINT UNSIGNED NOT NULL por defecto 24, CHECK 0–168 (límite de cancelación del paciente) |
| `appointment` | `reminder_enqueued_at` | DATETIME(3) NULL: marca del recordatorio ya encolado; índice `(status, reminder_enqueued_at, start_utc)` |
| `appointment` | `created_by_role` | ENUM ampliado: 'doctor','reception','patient' |
| `appointment` | `cancelled_by_role` | ENUM ampliado: 'doctor','reception','patient' |
| `calendar_action_log` | `actor_role` | ENUM ampliado con 'patient' |
| `calendar_action_log` | `action` | ENUM ampliado con `site_updated`, `data_authorized`, `link_revoked` |
| `one_time_token` | `purpose` | ENUM ampliado con `appointment_confirmation` y `appointment_reminder` |
| `one_time_token` | `appointment_id` | BIGINT UNSIGNED NULL, FK `appointment`: sujeto del token |

Para `doctor_patient` se rellenan los vínculos ya existentes con `origin = 'office'` (los creó el personal en la feature
2 o las pruebas de la feature 1); los nuevos que cree el paciente al reservar llevan `origin = 'patient'`.

## Reglas de lectura que cambian (aislamiento y revocación)

- `findPatientForDoctor`, `listPatientsForDoctor`, `findTutorForMinor`, el selector de pacientes y
  `findNotificationEmailForDoctor` exigen `doctor_patient.revoked_at IS NULL`: un vínculo revocado se comporta como si no
  existiera para el contacto del paciente.
- `listPatientNamesForDoctor` **incluye** los vínculos revocados: la agenda y el historial siguen mostrando el nombre en
  las citas pasadas.
- Agendar desde el personal (feature 2) a un paciente cuyo vínculo está revocado responde como paciente inalcanzable (404).

## Entidades derivadas (no son tablas)

- **Mes del calendario del paciente**: para cada día del mes, si hay al menos un horario libre que cumple la
  anticipación del médico (calculado con las citas y bloqueos del mes en dos consultas).
- **Mis citas**: citas vigentes futuras y las de los últimos 90 días de todas las personas de la cuenta, con el nombre
  del consultorio (la cuenta lee solo sus propias citas).
- **Mis consultorios**: consultorios con un vínculo activo con alguna persona de la cuenta, su origen y fecha.

## Relaciones

- `doctor` 1—1 `doctor_site`.
- `patient_account` N—M `doctor` a través de `data_authorization` (historial) y de `doctor_patient` (vínculo vigente por paciente).
- `appointment` 1—N `one_time_token` (por propósito: a lo sumo un token vivo por propósito).

## Transiciones de estado

```text
doctor_site:    (nada) ──elegir nombre──▶ draft ──publicar──▶ published ──despublicar──▶ unpublished ──publicar──▶ published
doctor_patient: (nada) ──reservar o agendar──▶ activo ──revocar──▶ revocado ──reservar el paciente──▶ activo (nueva autorización)
appointment:    booked ──cancelar (paciente, consultorio o revocación)──▶ cancelled        (sin reprogramación)
reminder:       reminder_enqueued_at NULL ──cron──▶ marcado (una sola vez)
```

## Reglas de integridad (resumen)

1. El nombre del enlace es único por el índice; elegirlo es una inserción única por médico.
2. Toda reserva, cancelación y revocación corre bajo `withCalendarLock` del médico afectado (una operación, un médico).
3. Un paciente solo puede reservar para personas de su cuenta; el micrositio nunca devuelve datos de pacientes.
4. El recordatorio se marca con una actualización condicional: a lo sumo una vez por cita.
5. La autorización de datos se registra antes o con la cita que la requiere, en la misma transacción.
