# Recuperación de contraseña administrativa

## Variables de entorno

Configura en Render, tanto para la aplicación como para el proceso manual de migración:

- `EMAIL_ENCRYPTION_KEY`: 32 bytes aleatorios codificados en 64 caracteres hexadecimales; se usa únicamente para AES-256-GCM.
- `EMAIL_LOOKUP_KEY`: clave independiente de 32 bytes para HMAC-SHA-256 del correo normalizado.
- `PASSWORD_RECOVERY_KEY`: clave independiente de 32 bytes para los HMAC de códigos y límites globales de recuperación.
- `SMTP_HOST`: `smtp.gmail.com`.
- `SMTP_PORT`: `465` (TLS implícito) o `587` (STARTTLS obligatorio).
- `SMTP_USER`: cuenta Gmail que autentica por SMTP.
- `SMTP_APP_PASSWORD`: contraseña de aplicación de Google; la aplicación elimina espacios de formato antes de autenticar.
- `EMAIL_FROM`: la misma dirección de `SMTP_USER`.

Conserva estas claves en un gestor seguro y en el almacén de variables de Render. No las compartas ni las guardes en el repositorio. Usa un valor distinto para cada clave. Una clave de cifrado perdida impide descifrar los correos ya migrados; una clave de búsqueda perdida impide localizar las cuentas.

Para generar valores nuevos en un equipo de confianza, ejecuta el siguiente comando por separado para cada clave y guarda el resultado directamente en el gestor de secretos:

```sh
node -p "require('node:crypto').randomBytes(32).toString('hex')"
```

No uses el mismo resultado para más de una variable.

## Migración controlada de los correos existentes

La migración `006_admin_email_encryption_password_recovery.sql` agrega columnas de cifrado y tablas de recuperación. Mantiene intacta la columna `users.email` para permitir verificar la conversión.

1. Haz y verifica un respaldo restaurable de PostgreSQL. Detén temporalmente el servicio administrativo para evitar inicios de sesión o creación de cuentas durante el cambio.
2. Configura `DATABASE_URL`, `EMAIL_ENCRYPTION_KEY` y `EMAIL_LOOKUP_KEY` en el entorno de la tarea de migración.
3. Ejecuta desde la raíz del proyecto:

   ```sh
   node scripts/migrate.js --database carpinteria_db
   node scripts/encrypt-admin-emails.js --database carpinteria_db
   ```

4. El segundo comando verifica el nombre de la base, cifra cada dirección, comprueba descifrado e HMAC y solo entonces pone `users.email` en `NULL` y fija las nuevas columnas como obligatorias. La operación está dentro de una transacción y bloquea la tabla durante la conversión. Solo informa el número de filas procesadas.
5. Si la verificación falla, el script revierte sus cambios y conserva los correos originales. No despliegues el nuevo código hasta resolver la causa y completar la conversión.
6. Tras el éxito, despliega el código nuevo y reanuda el servicio. El código anterior no puede autenticar una cuenta después de que su correo haya quedado en `NULL`; ten listo el respaldo para recuperación ante un fallo de despliegue.

El índice único de HMAC detecta correos que solo difieren en mayúsculas o espacios después de normalizarlos. Si hay duplicados, la transacción se revierte y no borra cuentas; resuelve la identidad duplicada manualmente antes de reintentar.

En una base nueva, ejecuta primero las migraciones y luego el script: procesará cero filas y dejará las columnas de correo cifrado obligatorias para las nuevas cuentas. El comando `admin:create-owner` requiere estas columnas y `ADMIN_EMAIL`; pide la contraseña de forma interactiva y guarda solo su hash existente.

## Gmail SMTP

1. Activa la verificación en dos pasos en la cuenta Google que enviará los mensajes.
2. En Seguridad de la cuenta, abre **Contraseñas de aplicaciones** y crea una para Mail. Google solo ofrece esta opción a cuentas elegibles con verificación en dos pasos; algunas cuentas administradas o con Protección avanzada pueden no mostrarla.
3. Guarda la contraseña de aplicación en `SMTP_APP_PASSWORD` de Render. Configura `SMTP_USER` y `EMAIL_FROM` con la misma cuenta, `SMTP_HOST=smtp.gmail.com` y `SMTP_PORT=465` o `587`.
4. Usa 465 para TLS desde la conexión o 587 con STARTTLS obligatorio. El transporte valida certificados y exige TLS 1.2 o posterior.

La aplicación envía únicamente el código de recuperación, nunca la contraseña nueva. Las respuestas de solicitud son genéricas. Se permiten hasta 3 solicitudes por cuenta, 10 por IP y 20 para todo el servicio cada 15 minutos; las validaciones se limitan a 10 por cuenta, 30 por IP y 400 para todo el servicio en la misma ventana. El código vence en diez minutos y permite cinco intentos. Para correos válidos pero desconocidos se hace una entrega señuelo al buzón SMTP, dentro del límite global, para reducir diferencias observables sin entregar un código útil. La IP se obtiene del socket, así que detrás de un proxy puede representar al proxy compartido; el límite por cuenta continúa aplicándose.

Gmail con contraseña de aplicación es una opción sencilla para un panel pequeño, pero Nodemailer advierte que Gmail puede bloquear conexiones de producción por actividad o ubicación inusual. Antes de depender de este canal, confirma que la cuenta puede usar SMTP desde Render y considera un proveedor transaccional u OAuth si Gmail lo bloquea.
