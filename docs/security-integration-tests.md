# Pruebas funcionales de seguridad

`test/security-regression.test.js` contiene guardas **estáticas** que buscan en el código opciones y patrones críticos; no ejercita rutas ni prueba el motor SQL. `test/security-integration.test.js` es una suite de integración real: inicia Express en loopback, se conecta a PostgreSQL, crea fixtures únicos, envía HTTP a rutas y limpia solo filas que identifica como propias.

`npm test` conserva una salida explícita de pruebas aprobadas/fallidas/omitidas; si no hay configuración, la integración aparece como **omitida**, nunca como aprobada. Para exigir integración, use `npm run test:security:integration`: si falta configuración, el runner informa `OMITIDA` y sale con código distinto de cero; si un valor no cumple el destino requerido, informa `NO EJECUTADA` antes de crear el proceso hijo; un fallo dentro del preflight de base debe aparecer como fallo del test. `npm run test:security:static` ejecuta solo las guardas estáticas. No presente el éxito de pruebas estáticas ni un resumen con integración omitida como validación dinámica.

El runner de integración construye el entorno del proceso hijo con una lista cerrada: las cuatro variables `CARPINTERIA_SECURITY_TEST_*` documentadas y `CARPINTERIA_SECURITY_TEST_REQUIRE_CONFIG=1`. No propaga `process.env`, `PATH`, `NODE_OPTIONS`, `DATABASE_URL` ni variables de otros servicios. Lanza Node mediante la ruta absoluta `process.execPath`; si esta no es absoluta o el destino no coincide con el clúster de prueba esperado, aborta sin crear el hijo. Las URLs admiten solo `postgres:`/`postgresql:`, credenciales no vacías (codifique en porcentaje los caracteres reservados), roles exactos `carpinteria_runtime` y `carpinteria_migrator`, `127.0.0.1:55432/carpinteria_db`, y rechazan query string, fragmentos y autoridad/ruta codificadas. Esto evita opciones de `pg-connection-string` como `host`, `port` y rutas de certificados SSL. Si el hijo acaba por señal, el runner informa el nombre de esa señal y usa un código distinto de cero; no registra configuración ni valores de conexión. La validación del URL y la allowlist **no son un sandbox de sistema operativo** ni limitan archivos, red, permisos o recursos del proceso.

Ejecute tanto las pruebas estáticas como las de integración únicamente dentro de un sandbox externo que aplique los controles indicados en la skill de seguridad: sin red externa, loopback aislado cuando se necesite, entorno allowlist, fuente de solo lectura, escritura limitada a scratch y cuotas de recursos. No ejecute código del proyecto si no puede imponerse ese aislamiento.

## Alcance de integración

La suite verifica inicio de sesión correcto/incorrecto, un email con sintaxis SQL que pasa la validación de formato, ausencia de sesión ante fallo, búsqueda administrativa SQL-like, un nombre SQL-like almacenado literalmente y parámetros de ruta con sintaxis de inyección. También comprueba API sin sesión, cookie de sesión aleatoria inválida, una sesión persistida de rol `administrator` rechazada por el control owner-only de carga de sesión (401), login sin CSRF (403), mutación owner autenticada sin CSRF (403) y con CSRF válido (201), catálogo y cotización válida/inválida, rechazo exacto de cuerpo comprimido no admitido (415) y de cuerpo sobredimensionado (413), mensajes sin detalles internos y el sexto fallo de login (429) aun cambiando `X-Forwarded-For` falsificado. Estos resultados describen las aserciones del código; no significan que la suite haya sido ejecutada.

La prueba del rol `administrator` no representa una petición 403 de autorización posterior a una autenticación aceptada: el middleware real `loadAdminSession` solo acepta sesión de owner y trata el resto como sesión inválida, lo cual responde 401. La única respuesta 403 cubierta es el fallo CSRF después de una sesión owner válida. El código actual no expone una ruta para probar a un usuario autenticado con rol insuficiente que después falle una autorización separada.

Los casos SQL dinámicos cubren login, búsqueda de biblioteca, una escritura de categoría y validación de identificadores de ruta/cotización. No demuestran por sí solos la seguridad de todas las consultas o entradas del sistema. La revisión estática de consultas en rutas y scripts debe informarse por separado; el conjunto de pruebas no es una prueba exhaustiva de SQL injection.

## Resultado de revisión estática SQL

La búsqueda estática de los puntos `query`/`client.query` en rutas, autenticación y scripts no encontró valores de solicitud concatenados dentro de SQL. Los filtros de biblioteca usan `$n`; IDs, JSON y valores de formularios se pasan en arrays de parámetros. Las únicas interpolaciones observadas dentro del SQL de aplicación son fragmentos de selección de medios (`mediaSelection`, `videoSelection`, `mediaVisibility`) construidos desde alternativas constantes del propio código. Las migraciones son archivos locales seleccionados por un patrón fijo; el nombre consultado en `schema_migrations` también se pasa como parámetro. Esto es una revisión de código, no prueba del parser de PostgreSQL ni garantía frente a cambios futuros.

Antes de modificar datos, comprueba host/puerto/base, propietario y marcador de base, que no haya otra conexión al database en ese instante, una llave advisory exclusiva, roles setup/runtime distintos y no privilegiados, que ningún otro rol no superusuario y no propietario tenga `CONNECT` efectivo, membresías heredadas, ACL directas y privilegios efectivos de esquema/tablas/secuencias, el conjunto exacto de esquemas y tablas esperado, migraciones completas y datos previos. Si cualquier control no coincide o una comprobación no puede completarse, aborta antes de crear fixtures. PostgreSQL superusers eluden ACL; la suite requiere que sus propios roles no sean superusuarios y rechaza otras sesiones observadas, pero no puede impedir una reconexión privilegiada posterior. El control de conexiones es una observación puntual y el propietario/comentario/nombre de base son valores declarados por el clúster; ninguno prueba que PostgreSQL se ejecute dentro de un entorno desechable. La garantía debe proceder de un clúster recién creado y restringido externamente, sin conectividad a otros recursos y con su directorio de datos y procesos confinados al sandbox. El servidor del test se enlaza solo a `127.0.0.1` con puerto efímero.

Las seis migraciones revisadas definen doce tablas de aplicación: `roles`, `users`, `categories`, `products`, `media_assets`, `product_media`, `business_settings`, `audit_log`, `admin_sessions`, `admin_login_attempts`, `admin_password_recoveries` y `admin_password_recovery_rate_limits`. El migrador crea además `schema_migrations`, por lo que el preflight espera trece tablas públicas en total. `schema_migrations` debe contener exactamente los seis nombres aprobados por la suite; `roles` debe contener solo las dos filas fijas `owner` y `administrator` creadas por la migración inicial. Las otras once tablas deben estar vacías antes de las fixtures. La comparación de esquema y la comprobación de filas son barreras adicionales: no sustituyen el clúster nuevo, marcador, propietario, restricciones de roles/ACL y verificación de conexiones.

## Aislamiento obligatorio

La aplicación no tiene un servidor PostgreSQL de pruebas configurado. No use el PostgreSQL de desarrollo/producción ni reutilice `.env`. Cree un clúster PostgreSQL local desechable desde cero, separado de cualquier clúster existente, escuche únicamente en `127.0.0.1:55432` y cree dentro una base llamada `carpinteria_db` (el ejecutor de migraciones rechaza otros nombres). En Windows, si PostgreSQL está instalado, una forma de iniciar un clúster temporal es:

```powershell
$testData = Join-Path $env:TEMP 'carpinteria-security-pg'
$testLog = Join-Path $env:TEMP 'carpinteria-security-pg.log'
if (Test-Path $testData) { throw 'La ruta temporal ya existe; comprueba su propietario antes de continuar.' }
initdb -D $testData -U postgres --auth-local=scram-sha-256 --auth-host=scram-sha-256
if ($LASTEXITCODE -ne 0) { throw 'initdb falló; no continúes con el clúster.' }
pg_ctl -D $testData -o '-h 127.0.0.1 -p 55432' -l $testLog start
if ($LASTEXITCODE -ne 0) { throw 'pg_ctl no inició el clúster temporal.' }
pg_ctl -D $testData status
```

Use una instalación PostgreSQL local confiable para esos binarios. Revise que la carpeta temporal no exista antes de inicializarla. La configuración no debe publicar el puerto ni conectarse a una instancia externa.

Conéctese al nuevo clúster usando su rol de instalación y cree roles distintos. Mantenga la inicialización, migración y pruebas dentro del mismo sandbox del sistema operativo. Escriba cada contraseña con `\\password` desde `psql`; no la ponga en un comando, archivo ni salida de terminal:

```sql
CREATE ROLE carpinteria_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE carpinteria_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE DATABASE carpinteria_db OWNER carpinteria_migrator;
```

Genere un UUID nuevo para este clúster y márquelo desde el rol de instalación, sin reutilizar un marcador de otras ejecuciones:

```sql
COMMENT ON DATABASE carpinteria_db IS 'carpinteria-security-test:00000000-0000-4000-8000-000000000001';
```

El UUID anterior es solo un ejemplo. Reemplácelo por un UUID nuevo en minúsculas y use el comentario exacto en `CARPINTERIA_SECURITY_TEST_DB_MARKER`. El marcador no es una credencial; identifica el destino desechable esperado.

Como `carpinteria_migrator`, dentro del sandbox, aplique las seis migraciones con `node scripts/migrate.js --database carpinteria_db` y `DATABASE_URL` apuntando exclusivamente a `127.0.0.1:55432/carpinteria_db`. Por ejemplo, después de inyectar el secreto de prueba en `CARPINTERIA_SECURITY_TEST_SETUP_URL`:

```powershell
$env:DATABASE_URL = $env:CARPINTERIA_SECURITY_TEST_SETUP_URL
node scripts/migrate.js --database carpinteria_db
Remove-Item Env:DATABASE_URL
```

El comando Node directo no lee `.env`. Aplique a continuación los `GRANT` de [database-runtime-role.md](database-runtime-role.md) en esa base. Para la suite, el URL setup es el del migrator no-superusuario y el URL runtime es el rol de ejecución. No dé `CREATEROLE`, `CREATEDB` ni `SUPERUSER` a runtime.

Inyecte los siguientes valores en el proceso desde un gestor local de secretos/configuración (no los guarde en `.env`). El runner pasa solo estos valores y el indicador interno de configuración requerida al proceso hijo:

```text
CARPINTERIA_SECURITY_TEST_ACK=disposable-loopback-postgres
CARPINTERIA_SECURITY_TEST_DB_MARKER=carpinteria-security-test:<UUID nuevo>
CARPINTERIA_SECURITY_TEST_SETUP_URL=<URL del rol migrator de la instancia desechable>
CARPINTERIA_SECURITY_TEST_RUNTIME_URL=<URL del rol runtime de la instancia desechable>
```

Después, desde el sandbox externo ya configurado, ejecute `npm run test:security:integration`. La suite verifica que comentario/propietario coincidan, usa un advisory lock para evitar ejecuciones simultáneas, rechaza URLs fuera de `127.0.0.1:55432/carpinteria_db`, roles distintos de los dos nombres requeridos, parámetros/fragmentos, superusuario, roles ajenos con conexión efectiva, miembros heredados, otras conexiones, esquemas/tablas no esperados, migraciones diferentes y datos previos. Estas barreras no sustituyen la verificación de que el puerto pertenece al clúster recién creado. Un nombre de base, un comentario y tablas vacías no son evidencia autónoma de desechabilidad. El sandbox debe impedir acceso a bases/servicios reales y el clúster temporal debe retirarse por completo al finalizar.

La limpieza usa IDs/correos/slug únicos de fixtures, eventos atribuibles al usuario fixture y hashes de buckets derivados de sockets aceptados por el servidor de pruebas. Los eventos anónimos `admin.login.failed` no tienen un identificador de correlación de ejecución en el esquema/aplicación; no se eliminan individualmente porque un cursor o timestamp podría capturar otra conexión concurrente. Se conservan hasta retirar el clúster desechable completo. No se borran rangos de IDs ni se ejecutan borrados globales de auditorías o `admin_login_attempts`. Las otras fixtures se eliminan por sus IDs o identificadores únicos. Cada operación de limpieza se intenta aunque falle otra; el fallo del hook queda visible junto con el fallo de prueba original, si lo hubo.

La suite no debe ejecutarse concurrentemente ni contra un clúster compartido. El bloqueo advisory y el rechazo de conexiones observadas reducen carreras, pero no impiden que un actor con acceso al clúster se conecte después del preflight. La contención del clúster, los procesos y los archivos corresponde al sandbox externo; al terminar, retire el clúster completo en lugar de reutilizarlo.

La extracción de cookies usa `Headers.getSetCookie()` cuando está disponible y, de otro modo, separa una cabecera combinada en límites que parecen iniciar otra cookie, sin dividir comas de fechas `Expires`. El paquete declara Node `>=20.6`; esta compatibilidad se revisó estáticamente, pero queda pendiente de validación real con la versión mínima en el sandbox.

Al terminar, apague y retire **solo la carpeta de ese clúster temporal** con el procedimiento de la instalación PostgreSQL usada. No elimine una carpeta si no ha comprobado su ruta absoluta y que pertenece al clúster temporal.

## Limitaciones de ejecución de esta auditoría

Los comandos de PostgreSQL `psql`, `pg_ctl`, `initdb` y `docker` no están disponibles en `PATH` en el entorno previamente inspeccionado; no se ha probado una conexión y no se afirma que haya un clúster aislado. Las pruebas funcionales quedan pendientes de un clúster desechable y del sandbox externo descrito arriba. La lista allowlist del runner reduce el entorno del hijo, pero no certifica el aislamiento del sistema operativo.
