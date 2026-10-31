# Catálogo de carpintería

Base inicial para el sitio público y el futuro panel privado de administración. Requiere Node.js 20.6+ y PostgreSQL.

## Preparación

1. Copia `.env.example` a `.env`, configura `DATABASE_URL` para `carpinteria_db`, define `ADMIN_EMAIL` con el correo autorizado del carpintero y define `ADMIN_RATE_LIMIT_KEY` con una clave aleatoria de al menos 32 bytes hexadecimales. Puedes generarla con `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` y guardarla solo en `.env`.
2. Instala dependencias con `npm install`.
3. Aplica el esquema con `npm run db:migrate -- --database carpinteria_db`. El comando comprueba el nombre real de la base antes de aplicar migraciones.
4. Crea la cuenta autorizada con `npm run admin:create-owner -- --database carpinteria_db`. El asistente usa `ADMIN_EMAIL`, solicita el nombre y oculta la contraseña mientras la escribes. No crea cuentas para otros correos ni hay credenciales predeterminadas.
5. Inicia en desarrollo con `npm run dev` o en modo normal con `npm start`.
6. Abre `http://localhost:3000` para el catálogo y `http://localhost:3000/admin` para la administración protegida.

## Borradores iniciales del catálogo

Después de aplicar las migraciones, puedes preparar los cuatro nombres provisionales como categorías y trabajos no publicados en `carpinteria_db` con:

```powershell
npm run db:seed:catalog -- --database carpinteria_db
```

El script exige que `DATABASE_URL` apunte realmente a `carpinteria_db`, inserta filas faltantes de forma repetible y revierte la transacción si encuentra una colisión con datos distintos. Solo crea borradores sin descripción, precio, medidas, reglas de precio ni fotografías. El esquema no tiene una marca específica de demostración; `is_published = FALSE` mantiene estos registros fuera de `GET /api/catalog`. No los publiques hasta completar y revisar la información real del negocio.

`GET /api/health` verifica el proceso y la conexión a PostgreSQL. El catálogo consulta la base de datos y muestra un estado vacío hasta que existan trabajos publicados. `002_catalog_configuration.sql` agrega las medidas y reglas de precio; `004_category_measurement_templates.sql` agrega plantillas de medidas opcionales por categoría. La migración 004 es aditiva: no crea medidas ni modifica productos existentes. Las plantillas se copian a cada producto solo cuando el carpintero las aplica explícitamente. Las dimensiones fijas se guardan aparte en la columna existente `products.dimensions` y no se usan para cotizar ni calcular precios. No hay tarifas predeterminadas. Las solicitudes se preparan localmente y se copian para compartirlas, sin enviarse automáticamente. Las reglas se evalúan en `POST /api/catalog/:id/estimate` y no se exponen en la API pública del catálogo.

El panel admite exclusivamente la identidad activa cuyo correo coincide con `ADMIN_EMAIL` y cuyo rol es `owner` o `administrator`; todas las demás cuentas quedan rechazadas también al validar una sesión existente. No hay registro público. Las sesiones persistentes se guardan en PostgreSQL como hash de un token aleatorio y duran hasta 8 horas; el navegador solo recibe una cookie `HttpOnly`, `SameSite=Strict` (con `Secure` en producción), nunca se usa `localStorage`. El panel permite cerrar la sesión actual o revocar todas las sesiones. Cambiar `ADMIN_EMAIL` y reiniciar el proceso invalida las sesiones que ya no coincidan. El acceso requiere también que `ADMIN_RATE_LIMIT_KEY` contenga al menos 32 bytes aleatorios en hexadecimal. Si se despliega detrás de un proxy, configura la topología de red de forma que la dirección usada por el límite de intentos represente de manera fiable al cliente; la aplicación no confía en `X-Forwarded-For` por defecto.

El formulario de reglas de precio acepta el JSON descrito en [docs/pricing-rules.md](docs/pricing-rules.md); déjalo vacío hasta que el negocio confirme sus reglas. Las dimensiones y reglas de producto se validan en el servidor. Los productos nuevos siempre quedan en borrador y solo se publican con una acción explícita.

## Fotografías

La migración `005_private_media_inbox.sql` agrega metadatos de nombre original, tamaño, lote, clasificación y visibilidad; conserva sin cambios las filas multimedia anteriores. Para aplicarla manualmente usa `npm run db:migrate -- --database carpinteria_db`. El panel recibe una fotografía por solicitud, aunque permite seleccionar y procesar un lote completo; cada archivo informa su propio resultado. Se aceptan JPG, PNG y WebP después de validar su firma binaria. Los límites configurables son `MEDIA_MAX_FILE_BYTES` (por defecto 5 MiB, máximo 20 MiB) y `MEDIA_MAX_BATCH_FILES` (por defecto 30, máximo 50).

Los archivos se guardan fuera de `public`, en `var/media` por defecto, o en la ruta indicada por `MEDIA_STORAGE_DIR`. La carpeta debe persistir entre reinicios y despliegues; en producción configúrala como volumen persistente del entorno. El proyecto no incluye un procesador de imágenes, por lo que la bandeja limita la vista a 24 registros por página y usa carga diferida, pero aún sirve el original y no genera miniaturas optimizadas.

No se crean credenciales ni contenido de negocio predeterminado. Mantén `.env` fuera del control de versiones. Más información: [arquitectura](docs/architecture.md), [reglas de medidas y precios](docs/pricing-rules.md) y [sistema visual](docs/design-system.md).
