# Procedimiento manual: rol PostgreSQL de ejecución

Este documento prepara la separación entre la cuenta normal de la aplicación y la cuenta que aplica migraciones. **No se ejecutó SQL ni se cambiaron credenciales.** Revise primero el esquema efectivo y el entorno de destino; aplique los comandos con una cuenta DBA en una ventana de cambio aprobada y con respaldo y reversión disponibles.

## Uso observado de `DATABASE_URL`

- `server/db.js` crea el pool de la aplicación usando `DATABASE_URL`.
- `scripts/migrate.js`, `scripts/seed-catalog.js` y `scripts/create-owner.js` también consumen `DATABASE_URL`, pero son operaciones de despliegue/operación que deben recibir una URL separada en su proceso de ejecución.
- El servidor consulta `roles` y `users`; consulta y administra `categories`, `products`, `media_assets` y `product_media`; registra eventos en `audit_log`; y administra `admin_sessions` y `admin_login_attempts`.
- El código de servidor inspeccionado no consulta `business_settings` ni `schema_migrations`. `schema_migrations` la crea y utiliza el proceso de migración.
- El catálogo público necesita lectura en categorías, productos, relaciones multimedia y metadatos multimedia. No necesita acceso a los binarios almacenados fuera de PostgreSQL.

## Roles separados

Crear roles sin incrustar contraseñas en SQL o Git. Un DBA debe ejecutar esto y guardar las credenciales usando el gestor de secretos del despliegue. En `psql`, use `\\password` para establecer cada secreto de forma interactiva.

```sql
CREATE ROLE carpinteria_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE carpinteria_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
```

La cuenta runtime no debe ser propietaria del esquema/tablas ni miembro del rol migrator. PostgreSQL no ofrece un `GRANT ALTER TABLE` granular: el migrator necesita ser propietario de los objetos que las migraciones alteran y permiso `CREATE` en el esquema donde crea objetos. Asígnele solo la propiedad del esquema de aplicación y sus tablas/secuencias, nunca superusuario ni propiedad de esquemas ajenos. Mantenga su URL fuera del servicio habitual y úsela solo en despliegues controlados. No conceda membresía de migrator a runtime.

Los otros comandos operativos también consumen `DATABASE_URL`: `db:seed:catalog` necesita leer e insertar en categorías/productos y sus secuencias; `admin:create-owner` necesita leer roles/usuarios e insertar usuarios/eventos de auditoría y las secuencias de usuarios/auditoría. Ejecútelos como tareas separadas con roles temporales y solo los permisos de esa tarea. No amplíe el rol runtime para facilitar seed o bootstrap.

## Permisos de runtime según las operaciones actuales

Los comandos siguientes son una plantilla para una base **dedicada** a Carpintería y el esquema `public` definido por `db/migrations/`. Confirme propietarios, otros usuarios de la base y privilegios predeterminados antes de aplicarlos. Revocar a `PUBLIC` afecta a todos los roles que hereden esos permisos, así que no lo haga en bases compartidas sin revisar sus dependencias.

```sql
REVOKE CONNECT, CREATE, TEMPORARY ON DATABASE nombre_de_la_base FROM PUBLIC;
GRANT CONNECT ON DATABASE nombre_de_la_base TO carpinteria_runtime, carpinteria_migrator;
GRANT USAGE ON SCHEMA public TO carpinteria_runtime;

GRANT SELECT ON TABLE public.roles, public.users,
  public.categories, public.products,
  public.media_assets, public.product_media
  TO carpinteria_runtime;

GRANT INSERT, UPDATE, DELETE ON TABLE public.categories, public.products,
  public.media_assets, public.product_media
  TO carpinteria_runtime;

GRANT INSERT ON TABLE public.audit_log TO carpinteria_runtime;
GRANT SELECT, INSERT, DELETE ON TABLE public.admin_sessions TO carpinteria_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.admin_login_attempts TO carpinteria_runtime;
```

Matriz de privilegios efectivos esperados para el runtime (las comprobaciones `has_table_privilege` deben coincidir también después de resolver membresías heredadas):

| Tabla | SELECT | INSERT | UPDATE | DELETE | TRUNCATE |
| --- | --- | --- | --- | --- | --- |
| `roles` | sí | no | no | no | no |
| `users` | sí | no | no | no | no |
| `categories` | sí | sí | sí | sí | no |
| `products` | sí | sí | sí | sí | no |
| `media_assets` | sí | sí | sí | sí | no |
| `product_media` | sí | sí | sí | sí | no |
| `business_settings` | no | no | no | no | no |
| `audit_log` | no | sí | no | no | no |
| `admin_sessions` | sí | sí | no | sí | no |
| `admin_login_attempts` | sí | sí | sí | sí | no |
| `schema_migrations` | no | no | no | no | no |

Ninguna tabla requiere `REFERENCES` o `TRIGGER`. En secuencias, runtime requiere solo `USAGE` en las secuencias de identidad de `categories`, `products`, `media_assets` y `audit_log` para inserts; no necesita `SELECT` ni `UPDATE` en ninguna secuencia. `roles` y `users` no requieren acceso runtime a sus secuencias. `TRUNCATE` se deniega en todas las tablas. Las excepciones de escritura anteriores corresponden a operaciones actuales del servidor: CRUD administrativo de categorías/productos/metadatos y relaciones multimedia, auditoría append-only, sesiones y el contador persistente de intentos.

El runtime inserta filas en las tablas de identidad `categories`, `products`, `media_assets` y `audit_log`. Para `nextval` en los inserts basta `USAGE`; no se recomienda `SELECT` (que habilita consultar el estado de secuencia) porque el código no usa `currval` ni `lastval`. Para evitar dar permiso sobre todas las secuencias del esquema, un DBA puede otorgar `USAGE` solo sobre las secuencias identidad asociadas a esas cuatro tablas después de comprobar los nombres reales:

```sql
DO $$
DECLARE
  table_name text;
  sequence_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['categories', 'products', 'media_assets', 'audit_log'] LOOP
    sequence_name := pg_get_serial_sequence(format('%I.%I', 'public', table_name), 'id');
    IF sequence_name IS NOT NULL THEN
      EXECUTE format('GRANT USAGE ON SEQUENCE %s TO %I', sequence_name, 'carpinteria_runtime');
    END IF;
  END LOOP;
END $$;
```

Runtime no necesita escritura en `roles` o `users`, acceso a `business_settings`, `schema_migrations`, DDL, creación de roles, ni privilegios globales. No revoque privilegios preexistentes a ciegas: inspeccione `information_schema.role_table_grants`, `pg_roles`, `pg_default_acl`, propietarios y membresías, y pruebe las operaciones legítimas con una base de staging aislada. Si una futura función cambia estos requisitos, revise esta lista antes de ampliar permisos.

En PostgreSQL anterior a la versión 15, `PUBLIC` puede tener `CREATE` sobre el esquema `public`. En una base dedicada a esta aplicación, el DBA debe comprobar esa concesión y considerar `REVOKE CREATE ON SCHEMA public FROM PUBLIC;` antes de probar que runtime no puede crear objetos. En una base compartida, no revoque permisos globales sin revisar quién depende de ellos.

## Aplicación y verificación

Configure secretos separados en el gestor de secretos. El servicio normal debe recibir la URL de `carpinteria_runtime`; la tarea de migraciones recibe la URL de `carpinteria_migrator`. No ponga secretos en la línea de comandos, registros o archivos versionados. En un despliegue PowerShell, prefiera inyectarlos en el entorno del proceso desde el gestor de secretos, ejecute `npm run db:migrate` como tarea controlada y configure después el servicio para usar runtime.

En staging, conectado como runtime, ejecute comprobaciones de solo lectura como las siguientes. Sustituya `nombre_de_la_base` por el nombre real y compare las respuestas con la matriz de permisos de arriba:

```sql
SELECT current_database(), current_user, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls
FROM pg_roles r WHERE r.rolname = current_user;

SELECT has_database_privilege(current_user, current_database(), 'CONNECT') AS database_connect,
       has_database_privilege(current_user, current_database(), 'CREATE') AS database_create,
       has_database_privilege(current_user, current_database(), 'TEMPORARY') AS database_temp;

SELECT CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
            ELSE COALESCE(grantee.rolname, acl.grantee::text) END AS grantee,
       acl.privilege_type, acl.is_grantable
FROM pg_database d
CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) AS acl
LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
WHERE d.datname = current_database()
  AND (acl.grantee = 0 OR acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'carpinteria_runtime'))
ORDER BY grantee, acl.privilege_type;

-- Membresías directas e indirectas visibles para runtime (esperado: cero).
SELECT r.rolname AS granted_role,
       pg_has_role(current_user, r.oid, 'MEMBER') AS is_member,
       pg_has_role(current_user, r.oid, 'USAGE') AS privileges_inherited_now
FROM pg_roles r
WHERE r.rolname <> current_user
  AND pg_has_role(current_user, r.oid, 'MEMBER');

-- ACL directas del runtime y de PUBLIC sobre objetos de aplicación.
SELECT n.nspname AS schema_name,
       CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
            ELSE COALESCE(grantee.rolname, acl.grantee::text) END AS grantee,
       acl.privilege_type, acl.is_grantable
FROM pg_namespace n
CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) AS acl
LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
WHERE n.nspname = 'public'
  AND (acl.grantee = 0 OR acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'carpinteria_runtime'))
ORDER BY grantee, acl.privilege_type;

SELECT n.nspname AS schema_name, c.relname AS object_name,
       CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
            ELSE COALESCE(grantee.rolname, acl.grantee::text) END AS grantee,
       acl.privilege_type, acl.is_grantable
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault(
  CASE WHEN c.relkind = 'S' THEN 'S' ELSE 'r' END, c.relowner
))) AS acl
LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
WHERE n.nspname = 'public'
  AND c.relname IN ('roles', 'users', 'categories', 'products', 'media_assets',
                    'product_media', 'business_settings', 'audit_log', 'admin_sessions',
                    'admin_login_attempts', 'schema_migrations')
  AND (acl.grantee = 0 OR acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'carpinteria_runtime'))
ORDER BY c.relname, grantee, acl.privilege_type;

-- ACL directas de secuencias de identidad; no mostrar secuencias ajenas.
SELECT c.relname AS sequence_name,
       CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
            ELSE COALESCE(grantee.rolname, acl.grantee::text) END AS grantee,
       acl.privilege_type, acl.is_grantable
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('S', c.relowner))) AS acl
LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
WHERE n.nspname = 'public' AND c.relkind = 'S'
  AND (acl.grantee = 0 OR acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'carpinteria_runtime'))
ORDER BY c.relname, grantee, acl.privilege_type;

SELECT has_schema_privilege(current_user, 'public', 'USAGE') AS schema_usage,
       has_schema_privilege(current_user, 'public', 'CREATE') AS schema_create,
       has_table_privilege(current_user, 'public.users', 'SELECT') AS users_select,
       has_table_privilege(current_user, 'public.users', 'INSERT') AS users_insert,
       (has_table_privilege(current_user, 'public.roles', 'INSERT')
         OR has_table_privilege(current_user, 'public.roles', 'UPDATE')
         OR has_table_privilege(current_user, 'public.roles', 'DELETE')) AS roles_write,
       has_table_privilege(current_user, 'public.categories', 'SELECT') AS categories_select,
       has_table_privilege(current_user, 'public.categories', 'INSERT') AS categories_insert,
       has_table_privilege(current_user, 'public.categories', 'UPDATE') AS categories_update,
       has_table_privilege(current_user, 'public.categories', 'DELETE') AS categories_delete,
       has_table_privilege(current_user, 'public.products', 'SELECT') AS products_select,
       has_table_privilege(current_user, 'public.products', 'INSERT') AS products_insert,
       has_table_privilege(current_user, 'public.products', 'UPDATE') AS products_update,
       has_table_privilege(current_user, 'public.products', 'DELETE') AS products_delete,
       has_table_privilege(current_user, 'public.media_assets', 'SELECT') AS media_assets_select,
       has_table_privilege(current_user, 'public.media_assets', 'INSERT') AS media_assets_insert,
       has_table_privilege(current_user, 'public.media_assets', 'UPDATE') AS media_assets_update,
       has_table_privilege(current_user, 'public.media_assets', 'DELETE') AS media_assets_delete,
       has_table_privilege(current_user, 'public.product_media', 'SELECT') AS product_media_select,
       has_table_privilege(current_user, 'public.product_media', 'INSERT') AS product_media_insert,
       has_table_privilege(current_user, 'public.product_media', 'UPDATE') AS product_media_update,
       has_table_privilege(current_user, 'public.product_media', 'DELETE') AS product_media_delete,
       has_table_privilege(current_user, 'public.admin_sessions', 'SELECT') AS sessions_select,
       has_table_privilege(current_user, 'public.admin_sessions', 'INSERT') AS sessions_insert,
       has_table_privilege(current_user, 'public.admin_sessions', 'DELETE') AS sessions_delete,
       has_table_privilege(current_user, 'public.admin_login_attempts', 'SELECT') AS attempts_select,
       has_table_privilege(current_user, 'public.admin_login_attempts', 'INSERT') AS attempts_insert,
       has_table_privilege(current_user, 'public.admin_login_attempts', 'UPDATE') AS attempts_update,
       has_table_privilege(current_user, 'public.admin_login_attempts', 'DELETE') AS attempts_delete,
       has_table_privilege(current_user, 'public.audit_log', 'INSERT') AS audit_insert;

SELECT table_name,
       has_table_privilege(current_user, format('public.%I', table_name), 'SELECT') AS can_select,
       has_table_privilege(current_user, format('public.%I', table_name), 'INSERT') AS can_insert,
       has_table_privilege(current_user, format('public.%I', table_name), 'UPDATE') AS can_update,
       has_table_privilege(current_user, format('public.%I', table_name), 'DELETE') AS can_delete,
       has_table_privilege(current_user, format('public.%I', table_name), 'TRUNCATE') AS can_truncate,
       has_table_privilege(current_user, format('public.%I', table_name), 'REFERENCES') AS can_reference,
       has_table_privilege(current_user, format('public.%I', table_name), 'TRIGGER') AS can_create_trigger
FROM unnest(ARRAY[
  'roles', 'users', 'categories', 'products', 'media_assets', 'product_media',
  'business_settings', 'audit_log', 'admin_sessions', 'admin_login_attempts', 'schema_migrations'
]) AS application_tables(table_name)
ORDER BY table_name;

SELECT table_name,
       pg_get_serial_sequence(format('public.%I', table_name), 'id') AS sequence_name,
       has_sequence_privilege(current_user, pg_get_serial_sequence(format('public.%I', table_name), 'id'), 'USAGE') AS can_use,
       has_sequence_privilege(current_user, pg_get_serial_sequence(format('public.%I', table_name), 'id'), 'SELECT') AS can_read_state,
       has_sequence_privilege(current_user, pg_get_serial_sequence(format('public.%I', table_name), 'id'), 'UPDATE') AS can_update_state
FROM unnest(ARRAY['roles', 'users', 'categories', 'products', 'media_assets', 'audit_log']) AS identity_tables(table_name)
ORDER BY table_name;
```

Expected table and sequence results must match the matrix exactly. `roles` and `users` sequence privileges must be false; `categories`, `products`, `media_assets` and `audit_log` sequence `USAGE` must be true while `SELECT`/`UPDATE` are false. Also verify `TRUNCATE`, `REFERENCES` and `TRIGGER` are false everywhere. `rolsuper`, `rolcreatedb`, `rolcreaterole`, `rolreplication`, `rolbypassrls`, `database_create`, `database_temp` and `schema_create` are false; `database_connect` is true with a direct, non-grantable `CONNECT` ACL for runtime. The database ACL query should show no `PUBLIC` grants. Inspect direct ACLs, role memberships (including transitive memberships), inherited effective privileges, owners and grant options; do not treat a direct ACL listing alone as the effective result. A `NULL` result means the referenced object/sequence is absent or not resolvable and must be investigated, not treated as a pass. Do not perform privilege changes or this verification in production during an audit.

The integration test suite can exercise runtime-denial checks, but it deliberately requires a *separate disposable local PostgreSQL cluster* bound only to `127.0.0.1:55432`. It refuses other hosts, ports, database names, role reuse, superuser setup/runtime roles, unexpected application schemas/tables, migrations other than the five reviewed files, and pre-existing mutable application rows. Its connection preflight rejects any other session active at that instant; its effective `CONNECT` check excludes superusers, because PostgreSQL superusers bypass ACLs. Neither check prevents a privileged process from reconnecting later. The only permitted pre-existing rows are the two seeded role definitions and the exact migration ledger. It checks that `product_media` and `business_settings`, along with the other mutable tables, are empty. The migration CLI itself requires the database name `carpinteria_db`, so the test database must have that name inside that separate cluster. Never point these test variables at the existing development or production cluster; OS-level containment is required.

The suite expects the migrations already applied, a restricted runtime role, and a distinct non-superuser setup/migration role. Supply the test URLs through the process environment from a secret manager; do not put them in `.env`, shell history, or logs. The integration runner passes only the four documented test variables and its internal required-config flag to the child process, using the absolute `process.execPath` path to Node without adding `PATH` or copying the ambient environment. It accepts only the two expected role names, literal loopback host/port/database path, and URLs without query strings or fragments; those restrictions prevent `pg-connection-string` destination overrides and file-backed SSL options. That allowlist limits inherited variables; it is not an OS-level sandbox. Run `npm run test:security:integration` only inside the OS-enforced sandbox described in `security-integration-tests.md`. Missing variables cause an explicit omitted result; invalid target configuration or a failed database preflight must not be treated as a pass. The suite creates uniquely named test rows and removes only identified rows afterward; anonymous `admin.login.failed` audit rows cannot be correlated to one execution and are deliberately retained. Retire the entire disposable database/cluster afterward rather than reusing it. Empty tables, database comments and loopback checks are preflight indicators, not proof of OS-level disposability.
