# Data Model: Cuentas y acceso

Convenciones: MariaDB (InnoDB), `id` BIGINT autoincremental salvo indicación, fechas en UTC (`DATETIME(3)`),
`created_at` en todas las tablas, correos normalizados (minúsculas, sin espacios) en columnas `*_normalized`. Los tipos
exactos se fijan en las migraciones. Los requisitos referenciados están en [spec.md](spec.md).

## Identidad

### user
Una fila por correo; un solo rol por correo (supuesto de la spec).
| Campo | Notas |
|-------|-------|
| id | |
| email, email_normalized | `email_normalized` único |
| role | `patient` · `doctor` · `reception` · `support` |
| password_hash | argon2id o bcrypt; nunca en claro (FR-032) |
| password_changed_at | |
| mfa_enabled, mfa_secret_encrypted | secreto TOTP cifrado en reposo |
| status | `active` · `disabled` |
| pending_email, pending_email_normalized | correo nuevo pendiente de confirmar; el de acceso (`email`) no cambia hasta que esa dirección abre el enlace |
| full_name | solo personal de recepción (los demás roles guardan su nombre en su propia tabla) |
| created_at | |

### mfa_recovery_code
`user_id`, `code_hash`, `used_at`. 10 por usuario; un solo uso.

### trusted_device
`user_id`, `device_hash`, `first_seen_at`, `last_seen_at`. Base de FR-037 (aviso de dispositivo nuevo).

### session
| Campo | Notas |
|-------|-------|
| id | |
| token_hash | SHA-256 del token; único |
| user_id | |
| active_doctor_id | solo recepción; se revalida en cada petición |
| mfa_verified | verdadero tras el segundo factor |
| csrf_secret | para el token sincronizador |
| created_at, last_seen_at, absolute_expires_at | caducidad por inactividad y tope absoluto |
| revoked_at | |

### one_time_token
Recuperación, invitación y otros enlaces de un solo uso (FR-026, FR-034).
| Campo | Notas |
|-------|-------|
| id | |
| token_hash | único |
| purpose | `password_reset` · `reception_invite` |
| user_id / invitation_id | sujeto según el propósito |
| expires_at | 30 min recuperación, 7 días invitación |
| used_at | se marca con actualización condicional |

### login_throttle
`scope` (`account` o `ip`), `key_hash`, `failures`, `locked_until`, `updated_at`. Sin guardar el correo en claro.

## Médicos

### doctor
| Campo | Notas |
|-------|-------|
| id, user_id | `user_id` único |
| full_name | |
| cedula_number, cedula_normalized | `cedula_normalized` único mientras no esté liberada (FR-003); `NULL` al liberarla |
| cedula_file_path, cedula_file_sha256 | archivo en directorio privado; sin adjuntos en correo |
| emergency_mobile | formato mexicano de 10 dígitos; único (FR-004); `NULL` al liberarlo |
| office_phone | opcional, puede ser fijo, no se verifica |
| approval_status | `pending` · `approved` · `rejected` (FR-005) |
| rejection_reason | |
| approved_at, approved_by_user_id | |
| trial_started_at, trial_ends_at | inicio al aprobar (FR-008); 5 días |
| created_at | |

Transiciones: `pending → approved`, `pending → rejected`, `rejected → pending` (reenvío, FR-009). `approved` no
vuelve atrás en esta feature. Cada transición escribe una fila en `doctor_review`.

### doctor_review
Historial de decisiones de soporte: `doctor_id`, `decision` (`approved`, `rejected`, `cedula_released`),
`reason`, `decided_by_user_id`, `decided_at`.

## Pacientes

### patient_account
Cuenta global del paciente (tutor): `user_id` único, `phone`.

### patient
Persona atendida; puede ser la propia cuenta o un menor.
| Campo | Notas |
|-------|-------|
| id | |
| account_id | cuenta que la administra (tutor) |
| full_name | |
| birth_date | fecha, no edad (FR-011) |
| email | opcional para menores; el titular usa el de su cuenta |
| phone | |
| is_minor_dependent | verdadero si se añadió bajo un tutor |
| created_at | |

Sin historial clínico ni resultado de triaje (principio I).

### doctor_patient
Relación médico-paciente; unidad de aislamiento (FR-013).
`doctor_id`, `patient_id`, `created_at`, **único (doctor_id, patient_id)**. En esta feature solo se crea desde un servicio
interno (la reserva llega en la feature 3); las pruebas la crean directamente.

## Recepción

### reception_invitation
| Campo | Notas |
|-------|-------|
| id | |
| doctor_id | |
| email_normalized | |
| status | `pending` · `accepted` · `expired` · `revoked` |
| invited_by_user_id | |
| created_at, expires_at | 7 días |
| accepted_at | |

El límite de 2 cuenta invitaciones `pending` y vínculos activos (FR-025); se aplica en una transacción que bloquea la
fila del médico.

### reception_membership
`doctor_id`, `reception_user_id`, `created_at`, `revoked_at`; único (doctor_id, reception_user_id) para el vínculo
vigente. Retirar el acceso pone `revoked_at` y revoca las sesiones de esa persona con ese médico (FR-028).

## Legal y consentimientos

### legal_document
| Campo | Notas |
|-------|-------|
| id | |
| type | `patient_privacy` · `doctor_privacy` · `reception_privacy` · `reception_confidentiality` · `terms_doctor` |
| version | entero creciente por tipo; único (type, version) |
| title, body | texto del documento |
| is_provisional | verdadero = sin revisión legal (FR-023) |
| published_at | |

### consent_acceptance (solo anexar)
| Campo | Notas |
|-------|-------|
| id | |
| user_id | quién aceptó |
| on_behalf_of_patient_id | si el tutor acepta por un menor |
| legal_document_id | qué documento y versión |
| accepted_at | cuándo |
| ip_hash | opcional; sin IP en claro |

Disparadores impiden `UPDATE` y `DELETE` (FR-020). Regla de reaceptación: el usuario debe tener una aceptación de la
última versión publicada de cada documento que le aplica, o se le bloquea el uso hasta aceptarla (FR-021).

## Auditoría

### patient_access_log (solo anexar)
`id`, `actor_user_id`, `actor_role`, `doctor_id` (contexto), `patient_id`, `outcome` (`allowed` · `denied`), `occurred_at`.
Sin contenido del paciente (FR-041). Disparadores impiden `UPDATE` y `DELETE`.

### reception_action_log
`id`, `actor_user_id` (quien hizo la acción: el médico o la persona de recepción), `doctor_id`, `action`
(`invite`, `accept`, `revoke_invitation`, `remove`, `select_active_doctor`), `target_type`, `target_id`,
`occurred_at`. Alimenta FR-030; las acciones de citas llegarán con la feature 3 sobre la misma tabla.

### security_event
`id`, `user_id`, `type` (`password_changed`, `new_device`, `mfa_enabled`, `email_changed`, `login_failed_burst` …),
`occurred_at`. Sin datos personales; sirve para los avisos por correo (FR-037).

## Correo

### email_outbox
`id`, `template`, `to_email`, `payload_ref` (identificadores; el enlace se construye al enviar), `status` (`queued` ·
`sent` · `failed`), `attempts`, `next_attempt_at`, `sent_at`. Se limpian las filas entregadas tras unos días.

## Relaciones clave

```text
user 1─1 doctor ─┬─ N doctor_patient N ─ patient N ─1 patient_account ─1 user
                 ├─ N reception_invitation
                 └─ N reception_membership N ─1 user(reception)
user 1─N session · trusted_device · mfa_recovery_code · consent_acceptance
legal_document 1─N consent_acceptance
patient 1─N patient_access_log (actor: user)
```

## Reglas de integridad que las pruebas deben cubrir

- Una cédula y un móvil de emergencias en como máximo una cuenta (índices únicos).
- Un token de un solo uso no se consume dos veces ni caducado, ni con dos peticiones simultáneas.
- Máximo 2 invitaciones vigentes (pendientes + activas) por médico, aun con peticiones simultáneas.
- Ninguna consulta de pacientes sin `doctor_id` del contexto; un médico no ve pacientes de otro.
- `consent_acceptance` y `patient_access_log` rechazan `UPDATE` y `DELETE`.
