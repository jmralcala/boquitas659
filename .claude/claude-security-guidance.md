# Modelo de amenazas (lo lee el revisor de security-guidance)

Aplicación Node/TypeScript. Marca como hallazgo cualquier cambio que viole estas reglas.

## Entradas y salidas
- Toda entrada externa (body, query, params, headers, archivos, webhooks, variables de otros servicios) se valida en runtime con un esquema antes de usarse.
- Nunca construir SQL, comandos de shell, rutas de archivo o URLs concatenando entrada del usuario. SQL siempre parametrizado.
- Rutas de archivo derivadas de entrada: normalizar y comprobar que quedan dentro del directorio permitido (path traversal).
- Peticiones salientes a URLs influidas por el usuario: validar host contra una lista permitida (SSRF); bloquear rangos privados y metadatos de nube.
- No reflejar entrada sin escapar en HTML. Evitar `innerHTML`, `dangerouslySetInnerHTML`, `document.write`.
- Al fusionar objetos con datos externos, proteger contra prototype pollution (`__proto__`, `constructor`, `prototype`).

## Autenticación y autorización
- Toda ruta que accede a datos de un usuario comprueba **propiedad/permiso en el servidor**, no solo que haya sesión (IDOR).
- Consultas multi-tenant siempre filtran por el identificador del tenant. Una consulta sin ese filtro es un hallazgo.
- JWT: verificar firma, algoritmo esperado, `exp`, `aud` e `iss`. Nunca aceptar `alg: none`.
- Cookies de sesión: `HttpOnly`, `Secure`, `SameSite`. Rutas que cambian estado tienen protección CSRF si usan cookies.
- Comparar secretos/tokens con comparación de tiempo constante.

## Secretos y datos sensibles
- Ningún secreto, token o contraseña en el código, en tests ni en logs. Se leen de variables de entorno.
- No registrar cuerpos de petición completos, cabeceras `Authorization`, cookies ni datos personales.
- Contraseñas: hash con argon2 o bcrypt; nunca cifrado reversible ni hash rápido (MD5/SHA1/SHA256 simples).
- Aleatoriedad para tokens y ids secretos: `crypto.randomBytes`/`randomUUID`, nunca `Math.random`.

## Ejecución de código
- Prohibido `eval`, `new Function` y `vm` con entrada externa.
- `child_process`: usar `execFile`/`spawn` con argumentos en arreglo, sin `shell: true`, y nunca con entrada del usuario sin lista permitida.
- Deserialización: solo formatos de datos (JSON) con validación; nada que reconstruya objetos arbitrarios.

## Dependencias y configuración
- No añadir dependencias sin necesidad. Desconfiar de paquetes nuevos, con pocos mantenedores o nombres parecidos a otros populares.
- CORS: nunca `*` junto con credenciales; lista explícita de orígenes.
- Cabeceras de seguridad (p. ej. helmet) y límite de tasa en endpoints públicos y de autenticación.
- Mensajes de error al cliente sin trazas ni detalles internos.

## Reglas propias de este proyecto
<!-- Añade aquí lo específico: p. ej. "toda tabla con datos de cliente tiene tenant_id" -->
