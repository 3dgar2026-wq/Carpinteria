# Catálogo de carpintería

Catálogo público y panel administrativo. Requiere PostgreSQL y Node.js `24.22.2` (fijado en `.node-version`, `package.json` y compatible con Render).

## Preparación

1. Instala Node.js `24.22.2` con un gestor compatible con `.node-version` (por ejemplo, fnm o nvm) y comprueba `node --version`.
2. Copia `.env.example` a `.env`, configura `DATABASE_URL` para PostgreSQL y las variables locales. Genera las claves administrativas con `powershell -NoProfile -File scripts/generate-admin-keys.ps1`; el script las escribe directamente en `.env` y no las imprime.
3. Instala dependencias con `npm ci`.
4. En una base local realmente nueva, aplica las seis migraciones con `npm run db:migrate -- --database carpinteria_db`. Comprueba e inspecciona el destino antes de ejecutar el comando.
5. Solo si la base nueva no tiene usuarios, crea el propietario con `npm run admin:create-owner -- --database carpinteria_db`. El asistente oculta la contraseña. No ejecutes este paso contra la base Neon ya inicializada: el propietario ya existe.
6. Inicia en desarrollo con `npm run dev`; este comando carga `.env`. `npm start` ejecuta el servidor sin leer archivos de entorno y requiere que las variables ya estén en el entorno del proceso.
7. Abre `http://localhost:3000` para el catálogo y `http://localhost:3000/admin` para la administración protegida.

Para Neon, usa `DATABASE_URL` (conexión agrupada) en el servidor y entrega `DATABASE_URL_UNPOOLED` únicamente a una tarea operativa que lo requiera. El migrador reconoce las seis migraciones numeradas 001–006; una base nueva requiere las seis, pero esta aplicación ya tiene propietario y no necesita volver a inicializarse. El migrador detiene objetos existentes sin ledger y exige revisión y respaldo antes de cambios incrementales. No ejecutes migraciones contra la base de producción como parte del arranque.

## Borradores iniciales del catálogo

Después de aplicar las migraciones, puedes preparar los cuatro nombres provisionales como categorías y trabajos no publicados en `carpinteria_db` con:

```powershell
npm run db:seed:catalog -- --database carpinteria_db
```

El script exige que `DATABASE_URL` apunte realmente a `carpinteria_db`, inserta filas faltantes de forma repetible y revierte la transacción si encuentra una colisión con datos distintos. Solo crea borradores sin descripción, precio, medidas, reglas de precio ni fotografías. El esquema no tiene una marca específica de demostración; `is_published = FALSE` mantiene estos registros fuera de `GET /api/catalog`. No los publiques hasta completar y revisar la información real del negocio.

`GET /api/health` verifica el proceso y la conexión a PostgreSQL. El catálogo consulta la base de datos y muestra un estado vacío hasta que existan trabajos publicados. `002_catalog_configuration.sql` agrega las medidas y reglas de precio; `004_category_measurement_templates.sql` agrega plantillas de medidas opcionales por categoría. La migración 004 es aditiva: no crea medidas ni modifica productos existentes. Las plantillas se copian a cada producto solo cuando el carpintero las aplica explícitamente. Las dimensiones fijas se guardan aparte en la columna existente `products.dimensions` y no se usan para cotizar ni calcular precios. No hay tarifas predeterminadas. Las solicitudes se preparan localmente y se copian para compartirlas, sin enviarse automáticamente. Las reglas se evalúan en `POST /api/catalog/:id/estimate` y no se exponen en la API pública del catálogo.

El único acceso aceptado es la cuenta activa cuyo correo coincide con `ADMIN_EMAIL` y cuyo rol es `owner`. El rol `administrator` se crea en el esquema, pero el código actual no admite ese rol para login, sesión ni recuperación; no hay gestión funcional de usuarios administradores. No hay registro público. Las sesiones persistentes se guardan en PostgreSQL como hash de un token aleatorio y duran hasta 8 horas; el navegador recibe una cookie `HttpOnly`, `SameSite=Strict` y `Secure` en producción. `ADMIN_RATE_LIMIT_KEY` debe contener al menos 32 bytes aleatorios en hexadecimal. En Render se ignoran `CF-Connecting-IP` y `X-Forwarded-For` porque público y privado comparten el listener; se aplican buckets de cuenta/servicio que no dependen de esos encabezados. La recuperación de contraseñas no estará operativa en producción hasta configurar y probar SMTP.

El formulario de reglas de precio acepta el JSON descrito en [docs/pricing-rules.md](docs/pricing-rules.md); déjalo vacío hasta que el negocio confirme sus reglas. Las dimensiones y reglas de producto se validan en el servidor. Los productos nuevos siempre quedan en borrador y solo se publican con una acción explícita.

## Fotografías

La migración `005_private_media_inbox.sql` agrega metadatos de nombre original, tamaño, lote, clasificación y visibilidad; conserva sin cambios las filas multimedia anteriores. Está aplicada junto con las migraciones 001–006 en Neon. Una base local nueva recibe el conjunto completo con `npm run db:migrate`; no ejecutes una migración aislada ni repitas migraciones en Neon. El panel recibe un archivo por solicitud, aunque permite seleccionar y procesar un lote completo; cada archivo informa su propio resultado. Se aceptan JPG, PNG y WebP para imágenes, y MP4/WebM para video, después de validar la firma binaria. Los límites configurables son `MEDIA_MAX_FILE_BYTES` (por defecto 5 MiB, máximo 20 MiB), `MEDIA_MAX_VIDEO_FILE_BYTES` (50 MiB por defecto, 100 MiB máximo) y `MEDIA_MAX_BATCH_FILES` (100 archivos por defecto).

El almacenamiento admite `local` únicamente en desarrollo y pruebas controladas. En producción el proceso se niega a arrancar salvo que `MEDIA_STORAGE_PROVIDER=cloudinary` esté definido exactamente y existan las tres variables `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY` y `CLOUDINARY_API_SECRET`. No hay fallback a disco local; las referencias locales heredadas se rechazan en producción sin modificar la base. Los binarios nuevos usan recursos autenticados de Cloudinary; solo se sirven imágenes asociadas a productos publicados y marcadas públicas. La bandeja y los medios privados requieren sesión administrativa.

Antes de mover los registros locales a Cloudinary, conserva un respaldo de `var/media` y ejecuta primero el inventario de solo lectura:

```powershell
npm run db:migrate-media-to-cloudinary -- --database neondb
```

Revisa el resultado y configura las variables de Cloudinary. Solo cuando el inventario sea correcto ejecuta la migración con `--apply`:

```powershell
npm run db:migrate-media-to-cloudinary -- --database neondb --apply
```

El script requiere `DATABASE_URL_UNPOOLED`, comprueba la base y el esquema `public`, verifica formato/tamaño y el contenido remoto antes de actualizar cada referencia. Mantiene los archivos locales y permite reintentar cargas de forma idempotente. Este paso no se ha ejecutado desde la aplicación; hay que verificar las imágenes en producción y conservar el respaldo antes de retirar cualquier copia local. El proyecto no incluye un procesador de imágenes, por lo que la bandeja pagina y carga de forma diferida los originales, sin generar miniaturas optimizadas.

No se crean credenciales ni contenido de negocio predeterminado. Mantén `.env` fuera del control de versiones. Más información: [arquitectura](docs/architecture.md), [reglas de medidas y precios](docs/pricing-rules.md) y [sistema visual](docs/design-system.md).

## Node.js y Render

Usa Node.js `24.22.2`; comprueba la selección con `node --version` antes de `npm ci`. `.node-version` lo fija para gestores locales compatibles y Render; `package.json` declara el mismo parche exacto. Las dependencias del lockfile declaran motores compatibles con Node 24.

La configuración declarativa está en `render.yaml`: build `npm ci`, inicio `node server/index.js`, health check `/api/health`. Completa todas las variables `sync: false` en el gestor de secretos de Render antes de crear el servicio. En particular, el servidor no arrancará en producción si `MEDIA_STORAGE_PROVIDER` no es exactamente `cloudinary` o faltan variables de Cloudinary. No se ejecutan migraciones automáticamente al iniciar. Consulta [despliegue en Render](docs/render-deployment.md) y [recuperación de contraseña](docs/password-recovery-deployment.md); SMTP sigue pendiente de configurar y probar.
