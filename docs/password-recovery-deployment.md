# Recuperación de contraseña administrativa

## Requisitos de producción

La recuperación requiere un propietario activo, las seis migraciones aplicadas, las claves históricas correctas y un servidor SMTP probado. Las claves y contraseñas se configuran solo en el gestor de secretos de Render; nunca en Git ni en logs.

- `EMAIL_ENCRYPTION_KEY`: 32 bytes aleatorios en hexadecimal (64 caracteres), AES-256-GCM.
- `EMAIL_LOOKUP_KEY`: clave independiente de 32 bytes hexadecimales para HMAC-SHA-256.
- `PASSWORD_RECOVERY_KEY`: clave independiente de 32 bytes hexadecimales para códigos y límites.
- `ADMIN_RATE_LIMIT_KEY`: clave independiente de al menos 32 bytes hexadecimales.
- `SMTP_HOST=smtp.gmail.com`.
- `SMTP_PORT=465` (TLS implícito) o `587` (STARTTLS obligatorio).
- `SMTP_USER`: cuenta de Gmail con autenticación SMTP.
- `SMTP_APP_PASSWORD`: contraseña de aplicación Gmail de 16 caracteres; el código elimina espacios de formato.
- `EMAIL_FROM`: dirección igual a `SMTP_USER` ignorando mayúsculas/minúsculas.

SMTP aún debe configurarse y probarse antes de ofrecer recuperación en producción. Si falta una variable, el formato no coincide o el envío falla, la ruta devuelve un error genérico y no se entrega un código útil. La app de correo no transmite la nueva contraseña.

Para Gmail, activa verificación de dos pasos y crea una contraseña de aplicación si la cuenta es elegible. Google puede bloquear conexiones desde ubicaciones inusuales; una entrega local exitosa no demuestra que funcionará desde Render. Si se usa otro proveedor, primero adapta y verifica `server/password-recovery-mail.js`; el código actual solo acepta Gmail con los puertos indicados.

## Estado actual de la base

La migración `006_admin_email_encryption_password_recovery.sql` crea los campos de correo cifrado y las tablas `admin_password_recoveries` y `admin_password_recovery_rate_limits`. Las seis migraciones están aplicadas en Neon y el propietario ya fue creado con sus campos de cifrado. No repitas migraciones, conversión de correo ni bootstrap contra la base actual.

`admin:create-owner` es solo para una base nueva ya migrada cuya tabla `users` esté vacía. Requiere `ADMIN_EMAIL`, `ADMIN_RATE_LIMIT_KEY` y las tres claves de correo/recuperación; solicita la contraseña oculta y crea el rol `owner`. El rol `administrator` existe en `roles`, pero login, sesión y recuperación solo admiten `owner`. No hay flujo activo para crear administradores.

La conversión de una base heredada con correos en claro es una operación de escritura separada. El script antiguo puede estar fijado a otro nombre de base y usa una conexión configurada localmente. No lo ejecutes en Neon ni cambies las claves sin una revisión, respaldo restaurable y plan de migración aprobados.

## Límites

El código de recuperación vence en diez minutos y permite cinco intentos. La solicitud tiene límites de 3 por cuenta, 10 por bucket de cliente y 20 globales cada 15 minutos. La verificación tiene 10 por cuenta, 30 por bucket de cliente y 400 globales. En Render, el bucket de cliente es estable por operación y no se deriva de IP reenviada: el listener también recibe tráfico privado y no puede autenticar el origen de `CF-Connecting-IP` o `X-Forwarded-For`. En desarrollo directo, la IP se toma del socket. Los correos válidos pero desconocidos reciben una entrega señuelo al buzón SMTP dentro del límite global, sin código útil.

Antes de habilitar esta función, realiza una prueba controlada de envío desde Render a un buzón autorizado. No incluyas claves, contraseñas SMTP, códigos de recuperación ni direcciones personales en el reporte. Esa prueba no se realizó durante esta preparación.
