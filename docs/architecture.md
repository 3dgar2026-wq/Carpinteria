# Arquitectura y plan

## Base técnica

La aplicación existente es un monolito modular con Node.js `24.22.2`, Express 5 y PostgreSQL. La versión de Node está fijada en `.node-version` y en `package.json`; Render usa `render.yaml`. El navegador usa HTML, CSS y JavaScript nativos. `server/` contiene HTTP, autenticación, lógica y almacenamiento; `db/migrations/` contiene cambios reproducibles; `public/` contiene las interfaces.

## Persistencia y migraciones

El proyecto conserva seis migraciones oficiales, aplicadas en el entorno Neon confirmado:

1. `001_initial_schema.sql`
2. `002_catalog_configuration.sql`
3. `003_admin_auth.sql`
4. `004_category_measurement_templates.sql`
5. `005_private_media_inbox.sql`
6. `006_admin_email_encryption_password_recovery.sql`

Estas migraciones definen doce tablas de aplicación: `roles`, `users`, `categories`, `products`, `media_assets`, `product_media`, `business_settings`, `audit_log`, `admin_sessions`, `admin_login_attempts`, `admin_password_recoveries` y `admin_password_recovery_rate_limits`. El migrador crea además `schema_migrations`, para trece tablas públicas esperadas en total. Las migraciones no crean un catálogo de negocio. La lista se deriva estáticamente del SQL; no se consultó Neon durante esta revisión.

La migración inicial crea los roles `owner` y `administrator`. El código actual solo permite autenticación, sesiones y recuperación al usuario activo con rol `owner` y correo que coincide con `ADMIN_EMAIL`. No hay flujo funcional de administración de usuarios ni permisos para iniciar como `administrator`; el rol no se habilita aquí.

Las migraciones se aplican mediante tarea operativa controlada, nunca durante el arranque. `DATABASE_URL` sirve al runtime; `DATABASE_URL_UNPOOLED` se reserva para migraciones y tareas de mantenimiento cuando corresponda. El migrador detecta el nombre de base, objetos existentes, ledger y respaldo antes de continuar. Las seis migraciones están aplicadas en Neon; no se ejecutó ninguna migración en esta intervención.

## Catálogo, autenticación y multimedia

El catálogo público solo muestra productos publicados, categorías activas y medios relacionados que estén marcados como públicos. El administrador usa sesiones aleatorias persistidas como hash, CSRF, contraseñas scrypt y cookies `HttpOnly`, `SameSite=Strict` y `Secure` en producción. Los límites se guardan en PostgreSQL con HMAC. El rol `administrator` permanece sembrado pero no admitido por las consultas owner-only.

La recuperación requiere las claves criptográficas existentes y SMTP configurado. El proveedor actual solo admite Gmail SMTP con puerto 465 o 587, TLS mínimo 1.2, y `EMAIL_FROM` igual a `SMTP_USER`. No se ha configurado ni probado SMTP; por ello la recuperación no está lista para producción.

En desarrollo y pruebas controladas puede usarse `MEDIA_STORAGE_PROVIDER=local` con archivos privados fuera de `public`. En producción se exige `MEDIA_STORAGE_PROVIDER=cloudinary` y las variables Cloudinary completas antes de que se importe la aplicación. Las cargas nuevas usan recursos autenticados; PostgreSQL conserva metadatos e identificadores, no binarios. Las referencias locales heredadas se rechazan en producción y no disparan una migración automática. Las rutas públicas verifican publicación, asociación y visibilidad; la biblioteca privada requiere sesión administrativa.

Las eliminaciones de Cloudinary se intentan antes de borrar referencias y se restauran desde un respaldo temporal si falla la transacción. Ante un resultado ambiguo de `COMMIT`, se conserva el recurso remoto para evitar romper una referencia que pudo haberse confirmado; esto puede dejar un huérfano que requiere conciliación manual. La migración de archivos locales es explícita, idempotente y conserva las copias locales.

Render es el servicio web y usa `npm ci`, `node server/index.js` y health check `/api/health`. Las solicitudes públicas pasan por Cloudflare y Render permite también tráfico privado al mismo listener; la aplicación no puede autenticar desde el proceso la procedencia de `CF-Connecting-IP`. En Render se ignoran `CF-Connecting-IP` y `X-Forwarded-For`, Express deja `trust proxy=false`, y los limitadores aplican buckets estables de cuenta/servicio. Esto evita falsificación de IP mediante encabezados, pero sustituye el bucket individual por IP por uno más restrictivo del servicio.

## Plan por etapas

1. Inspección, diseño y base técnica.
2. Autenticación de propietario, sesiones y autorización de rutas.
3. CRUD de categorías y trabajos, multimedia, publicación y auditoría.
4. Catálogo público conectado a PostgreSQL.
5. Cotizaciones y contacto mediante canal configurado.
6. Administración ampliada, SMTP, pruebas aisladas, despliegue y validación.

## Cotizaciones por WhatsApp

El catálogo usa un enlace Click to Chat (`wa.me`) para abrir la conversación con un texto prellenado. La solicitud contiene enlaces absolutos a las fotografías y videos públicos asociados a cada producto seleccionado; este enlace no adjunta los archivos. Para enviar medios automáticamente se necesitaría una integración backend con WhatsApp Business Platform Cloud API, un número de teléfono registrado, credenciales de Meta, carga o referencias de medios admitidas y una llamada al endpoint de mensajes. Esa integración y sus costos/condiciones no están configurados ni se incorporan en esta mejora.
