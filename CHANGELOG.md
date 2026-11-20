# Changelog de la plantilla

## 0.1.4
- Workflows `ci.yml` y `security.yml`: omiten `npm ci` y la auditoría con un aviso cuando no hay `package-lock.json`, y omiten CodeQL cuando no hay código JS/TS de aplicación (antes fallaban en la plantilla y en proyectos recién creados).

## 0.1.3
- Añadido `.gitattributes` (LF en scripts y configuración) para evitar que Git en Windows rompa los `.sh` con CRLF.
- `docs/INSTALACION-POR-MAQUINA.md`: pasos para subir la plantilla a GitHub, incluida la restauración del permiso de ejecución.

## 0.1.2
- `README.md`: pasos detallados por proyecto (10 pasos con comandos) y enlace al listado por máquina.
- Nuevo `docs/INSTALACION-POR-MAQUINA.md`: checklist de lo que se instala una sola vez, con comandos de Windows, verificaciones y problemas frecuentes.

## 0.1.1
- Corregida la instalación de `security-guidance`: se hace desde la shell y requiere registrar antes el marketplace oficial. `/plugin install` no funciona en el panel de VS Code.
- `doctor.sh`: acepta `python` además de `python3` (Windows) y avisa si el plugin no está instalado.
- `new-project.sh`: detecta si el plugin ya está instalado y solo entonces omite el recordatorio.

## 0.1.0
- Versión inicial.
