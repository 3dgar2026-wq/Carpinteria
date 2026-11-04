# Preparación de despliegue en Render

`render.yaml` declara un Web Service Node sin ejecutar migraciones durante el arranque:

- Runtime: Node.js `24.22.2`, fijado por `NODE_VERSION`, `.node-version` y `package.json`.
- Build: `npm ci`.
- Start: `node server/index.js`.
- Health check: `/api/health`.
- Puerto: Render entrega `PORT`; Express escucha en `0.0.0.0`.
- `NODE_ENV=production` y `MEDIA_STORAGE_PROVIDER=cloudinary`.

## Arranque en Render

La página `SERVICE WAKING UP` pertenece a Render, no a los archivos estáticos de esta aplicación. En un servicio Free, Render duerme la instancia después de 15 minutos sin tráfico y muestra una pantalla de carga mientras la vuelve a iniciar; Render indica que ese arranque puede tardar aproximadamente un minuto. Si el servicio no está en Free, esa pantalla por sí sola no identifica la causa y se deben revisar los eventos y logs del servicio en el Dashboard.

El proceso valida la configuración requerida antes de escuchar, toma el puerto `PORT` asignado y enlaza `0.0.0.0`. `/api/health` comprueba PostgreSQL con `SELECT 1`, por lo que devuelve `503` si la base aún no responde. El catálogo reintenta hasta dos veces con espera creciente ante fallos transitorios de carga. Estos comportamientos se revisaron en el código, pero no se consultó el endpoint público ni los logs del servicio; el estado del plan y del arranque desplegado queda pendiente de validación desde el Dashboard.

Sin cambiar de plan, el cliente puede esperar a que Render termine el arranque y volver a cargar si la página de espera no continúa. Si la demora ocurre mientras el servicio ya figura activo, o el health check sigue fallando después del arranque, se deben revisar los eventos, logs y el resultado de `/api/health` en ese momento antes de atribuirlo a la suspensión por inactividad. Evita sondeos periódicos automáticos para mantener despierto un servicio Free.

El comando de Render no lee `.env`; el servidor utiliza exclusivamente las variables configuradas para el servicio. En local, `npm run dev` carga el archivo `.env`; `npm start` ejecuta `node server/index.js` sin cargar archivos de entorno. La validación de `DATABASE_URL`, Cloudinary y demás configuración requerida permanece activa antes de que el servidor escuche.

Completa en Render los valores `sync: false` con el gestor de secretos:

| Variable | Uso |
| --- | --- |
| `DATABASE_URL` | Conexión pooled de Neon para runtime. |
| `ADMIN_EMAIL` | Correo permitido para la cuenta owner existente. |
| `ADMIN_RATE_LIMIT_KEY` | HMAC de limitadores, hexadecimal, al menos 32 bytes. |
| `EMAIL_ENCRYPTION_KEY` | AES-256-GCM; conserva exactamente la clave existente. |
| `EMAIL_LOOKUP_KEY` | HMAC de identidad; conserva exactamente la clave existente. |
| `PASSWORD_RECOVERY_KEY` | HMAC de recuperación; conserva exactamente la clave existente. |
| `CLOUDINARY_CLOUD_NAME` | Cloud Name, sin espacios ni controles. |
| `CLOUDINARY_API_KEY` | Credencial del SDK oficial. |
| `CLOUDINARY_API_SECRET` | Credencial del SDK oficial. |
| `SMTP_HOST` | Actualmente debe ser `smtp.gmail.com`. |
| `SMTP_PORT` | `465` o `587`. |
| `SMTP_USER` | Usuario Gmail SMTP. |
| `SMTP_APP_PASSWORD` | Contraseña de aplicación Gmail. |
| `EMAIL_FROM` | Debe coincidir con `SMTP_USER`. |

No incluyas `DATABASE_URL_UNPOOLED` en el servicio web habitual; inyéctala solo en una tarea de migración/operación aprobada. El servidor no inicializa el esquema ni crea al propietario al arrancar. Las seis migraciones y el propietario ya existen en Neon.

El servidor termina antes de escuchar si `NODE_ENV=production` y `MEDIA_STORAGE_PROVIDER` no es exactamente `cloudinary`, o si falta una variable Cloudinary, está vacía, contiene espacios o tiene formato inválido. Las variables de secreto no aparecen en los mensajes. Las referencias locales heredadas no se leen, borran ni migran en producción. No se montó un disco persistente para medios.

Antes de publicar, configura las variables desde el gestor de secretos, confirma que la cuenta Cloudinary y el SMTP autorizados siguen activos y prueba SMTP desde Render. La recuperación no debe ofrecerse hasta que esa prueba de entrega sea satisfactoria. Después del despliegue, comprueba health, login owner, lectura/subida de prueba controlada si está autorizada, y persistencia en reinicio. Estas verificaciones de Render no se ejecutaron durante esta preparación.
