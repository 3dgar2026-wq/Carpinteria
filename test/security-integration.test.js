import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { gzipSync } from 'node:zlib';
import { decryptAdminEmail, encryptAdminEmail, getEmailCryptoKeys, lookupAdminEmail } from '../server/admin-email-crypto.js';

const { Pool } = pg;
const acknowledgement = process.env.CARPINTERIA_SECURITY_TEST_ACK;
const databaseMarker = process.env.CARPINTERIA_SECURITY_TEST_DB_MARKER;
const requireConfiguration = process.env.CARPINTERIA_SECURITY_TEST_REQUIRE_CONFIG === '1';
const runtimeUrlText = process.env.CARPINTERIA_SECURITY_TEST_RUNTIME_URL;
const setupUrlText = process.env.CARPINTERIA_SECURITY_TEST_SETUP_URL;
const expectedDatabase = 'carpinteria_db';
const expectedHost = '127.0.0.1';
const expectedPort = '55432';
const expectedRuntimeRole = 'carpinteria_runtime';
const expectedSetupRole = 'carpinteria_migrator';

function parseTestConnectionUrl(value) {
  // Keep the authority and database path literal so WHATWG URL and pg-connection-string
  // cannot normalize them into different destinations. Only credentials may be escaped.
  if (typeof value !== 'string'
    || !/^postgres(?:ql)?:\/\/(?:[a-z\d._~-]|%[a-f\d]{2})+:(?:[a-z\d._~-]|%[a-f\d]{2})+@127\.0\.0\.1:55432\/carpinteria_db$/iu.test(value)) return null;

  try {
    const url = new URL(value);
    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)
      || url.hostname !== expectedHost || url.port !== expectedPort
      || url.pathname !== `/${expectedDatabase}` || url.search !== '' || url.hash !== ''
      || !username || !password || /[\u0000-\u001f\u007f]/u.test(username + password)) return null;
    return { username };
  } catch {
    return null;
  }
}

const configFailure = (() => {
  if (acknowledgement !== 'disposable-loopback-postgres') return 'requiere CARPINTERIA_SECURITY_TEST_ACK=disposable-loopback-postgres';
  if (!databaseMarker || !/^carpinteria-security-test:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(databaseMarker)) {
    return 'requiere un marcador UUID de base desechable';
  }
  if (!runtimeUrlText || !setupUrlText) return 'requiere URLs runtime y setup exclusivas para pruebas';

  const runtime = parseTestConnectionUrl(runtimeUrlText);
  const setup = parseTestConnectionUrl(setupUrlText);
  if (!runtime || !setup) return 'las URLs deben usar credenciales y el destino PostgreSQL desechable documentado, sin parámetros ni fragmentos';
  if (runtime.username !== expectedRuntimeRole || setup.username !== expectedSetupRole) {
    return 'las URLs deben usar los roles runtime y migrator esperados';
  }

  return null;
})();

if (configFailure) {
  if (requireConfiguration) throw new Error(`Integración de seguridad no ejecutada: ${configFailure}`);
  test('security integration suite (requires the isolated local PostgreSQL cluster)', { skip: configFailure }, () => {});
} else {
  let setupPool;
  let runtimePool;
  let server;
  let baseUrl;
  let userId;
  let unauthorizedUserId;
  let unauthorizedSessionToken;
  let categoryId;
  let unauthorizedEmail;
  let unauthorizedEmailLookupHash;
  let fixtureCategorySlug;
  let fixtureProductSlug;
  const createdAdminCategorySlugs = new Set();
  let productId;
  let testEmail;
  let testEmailLookupHash;
  let testPassword;
  let rateLimitKey;
  let runtimeUsername;
  const ownedRateLimitBuckets = new Set();

  const safeSql = (text, values = []) => setupPool.query(text, values);

  function cookiesFrom(response) {
    const all = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : (response.headers.get('set-cookie') ?? '').split(/,(?=\s*[^=;,\s]+=)/u).filter(Boolean);
    return all.map((value) => value.split(';', 1)[0]).filter((value) => value.includes('=') && !value.endsWith('='));
  }

  async function login(email, password, forwardedFor) {
    const page = await fetch(`${baseUrl}/admin/login`);
    assert.equal(page.status, 200);
    const html = await page.text();
    const csrf = html.match(/name="csrf_token" value="([a-f0-9]{64})"/);
    assert.ok(csrf, 'login form should contain a CSRF token');
    const loginCookie = cookiesFrom(page).find((value) => value.startsWith('carpinteria_admin_login_csrf='));
    assert.ok(loginCookie, 'login form should set its CSRF cookie');

    const response = await fetch(`${baseUrl}/admin/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        cookie: loginCookie,
        'content-type': 'application/x-www-form-urlencoded',
        ...(forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {}),
      },
      body: new URLSearchParams({ csrf_token: csrf[1], email, password }),
    });
    return { response, body: await response.text(), cookies: cookiesFrom(response) };
  }

  before(async () => {
    runtimeUsername = parseTestConnectionUrl(runtimeUrlText).username;
    setupPool = new Pool({ connectionString: setupUrlText, max: 1 });

    const setupIdentity = await safeSql(`
      SELECT current_database() AS database, current_user AS role,
             inet_server_addr()::text AS server_address, inet_server_port() AS server_port,
             r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls,
             NOT EXISTS (
               SELECT 1 FROM pg_roles candidate_role
               WHERE candidate_role.rolname <> current_user AND pg_has_role(current_user, candidate_role.oid, 'MEMBER')
             ) AS no_role_memberships,
             d.datdba::regrole::text AS database_owner,
             obj_description(d.oid, 'pg_database') AS database_marker
      FROM pg_roles r CROSS JOIN pg_database d
      WHERE r.rolname = current_user AND d.datname = current_database()
    `);
    const runtimeCheckPool = new Pool({ connectionString: runtimeUrlText, max: 1 });
    try {
      const runtimeIdentity = await runtimeCheckPool.query(`
        SELECT current_database() AS database, current_user AS role,
               inet_server_addr()::text AS server_address, inet_server_port() AS server_port,
               r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls
        FROM pg_roles r WHERE r.rolname = current_user
      `);
      const setup = setupIdentity.rows[0];
      const runtime = runtimeIdentity.rows[0];
      assert.equal(setup.database, expectedDatabase);
      assert.equal(runtime.database, expectedDatabase);
      assert.equal(setup.server_address, expectedHost);
      assert.equal(runtime.server_address, expectedHost);
      assert.equal(setup.server_port, Number(expectedPort));
      assert.equal(runtime.server_port, Number(expectedPort));
      assert.notEqual(setup.role, runtime.role);
      assert.equal(setup.role, expectedSetupRole);
      assert.equal(runtime.role, expectedRuntimeRole);
      assert.equal(setup.no_role_memberships, true, 'setup role must not inherit privileges through other roles');
      assert.equal(setup.database_owner, setup.role, 'setup role must own the isolated disposable database');
      assert.equal(setup.database_marker, databaseMarker, 'database must carry the exact disposable-run marker');
      assert.equal(runtime.role, runtimeUsername);
      assert.equal(setup.rolsuper, false, 'test setup role must not be a superuser');
      assert.equal(setup.rolcreatedb, false);
      assert.equal(setup.rolcreaterole, false);
      assert.equal(setup.rolreplication, false);
      assert.equal(setup.rolbypassrls, false);
      assert.equal(runtime.rolsuper, false, 'application runtime role must not be a superuser');
      assert.equal(runtime.rolcreatedb, false);
      assert.equal(runtime.rolcreaterole, false);
      assert.equal(runtime.rolreplication, false);
      assert.equal(runtime.rolbypassrls, false);
    } finally {
      await runtimeCheckPool.end();
    }

    const lease = await safeSql('SELECT pg_try_advisory_lock(742310, 1) AS acquired');
    assert.equal(lease.rows[0].acquired, true, 'another security test run must not hold the disposable database lease');

    const competingConnections = await safeSql(`
      SELECT count(*)::integer AS count
      FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
    `);
    assert.equal(competingConnections.rows[0].count, 0,
      'abort unless no other process is connected to the disposable database');

    const expectedMigrations = [
      '001_initial_schema.sql',
      '002_catalog_configuration.sql',
      '003_admin_auth.sql',
      '004_category_measurement_templates.sql',
      '005_private_media_inbox.sql',
      '006_admin_email_encryption_password_recovery.sql',
    ];
    const migrations = await safeSql('SELECT name FROM schema_migrations ORDER BY name');
    assert.deepEqual(migrations.rows.map(({ name }) => name), expectedMigrations.slice().sort(),
      'test database must contain exactly the migrations reviewed for this suite');

    const schemas = await safeSql(`
      SELECT nspname AS name
      FROM pg_namespace
      WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'
      ORDER BY nspname
    `);
    assert.deepEqual(schemas.rows.map(({ name }) => name), ['public'],
      'test database must not contain additional application schemas');

    const applicationTables = await safeSql(`
      SELECT c.relname AS name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'f', 'm')
      ORDER BY c.relname
    `);
    const expectedTables = [
      'admin_login_attempts', 'admin_password_recoveries', 'admin_password_recovery_rate_limits',
      'admin_sessions', 'audit_log', 'business_settings',
      'categories', 'media_assets', 'product_media', 'products', 'roles',
      'schema_migrations', 'users',
    ];
    assert.deepEqual(applicationTables.rows.map(({ name }) => name), expectedTables,
      'public schema must contain only the tables defined by the reviewed migrations');

    const identitySequences = await safeSql(`
      SELECT table_name,
             pg_get_serial_sequence(format('public.%I', table_name), 'id') AS sequence_name
      FROM unnest(ARRAY['roles', 'users', 'categories', 'products', 'media_assets', 'audit_log']) AS identities(table_name)
      ORDER BY table_name
    `);
    assert.equal(identitySequences.rowCount, 6);
    assert.ok(identitySequences.rows.every(({ sequence_name }) => typeof sequence_name === 'string' && sequence_name.length > 0),
      'every reviewed identity column must resolve to its PostgreSQL sequence');
    const publicSequences = await safeSql(`
      SELECT count(*)::integer AS count
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'S'
    `);
    assert.equal(publicSequences.rows[0].count, 6,
      'public must contain only the six identity sequences defined by the reviewed schema');

    const seededRoles = await safeSql('SELECT code FROM roles ORDER BY code');
    assert.deepEqual(seededRoles.rows.map(({ code }) => code), ['administrator', 'owner'],
      'the only pre-existing application rows allowed are the two roles seeded by the initial migration');

    const existingData = await safeSql(`
      SELECT
        (SELECT count(*) FROM users) AS users,
        (SELECT count(*) FROM categories) AS categories,
        (SELECT count(*) FROM products) AS products,
        (SELECT count(*) FROM media_assets) AS media_assets,
        (SELECT count(*) FROM product_media) AS product_media,
        (SELECT count(*) FROM business_settings) AS business_settings,
        (SELECT count(*) FROM admin_sessions) AS admin_sessions,
        (SELECT count(*) FROM admin_login_attempts) AS login_attempts,
        (SELECT count(*) FROM admin_password_recoveries) AS password_recoveries,
        (SELECT count(*) FROM admin_password_recovery_rate_limits) AS recovery_rate_limits,
        (SELECT count(*) FROM audit_log) AS audit_log
    `);
    assert.ok(Object.values(existingData.rows[0]).every((count) => Number(count) === 0),
      'test database must contain no application data; the suite will not delete or overwrite existing rows');
    const runtimeChecks = await runtimeCheckPrivileges(runtimeUrlText, runtimeUsername);
    const privileges = runtimeChecks.rows[0];
    assert.equal(privileges.expected_role, true);
    for (const denied of [
      'can_create_in_public', 'can_insert_users', 'can_write_roles',
      'can_read_migrations', 'can_read_business_settings', 'can_use_users_sequence',
      'can_create_database_objects', 'can_create_temp_tables',
      'can_use_roles_sequence',
    ]) assert.equal(privileges[denied], false, `runtime must not have ${denied}`);
    for (const control of [
      'no_unneeded_table_write', 'no_table_truncate', 'no_table_reference_or_trigger',
      'no_sequence_select_or_update', 'no_unexpected_sequence_usage',
    ]) assert.equal(privileges[control], true, `runtime must satisfy ${control}`);
    assert.equal(privileges.no_role_memberships, true, 'runtime must not inherit privileges through other roles');
    assert.equal(privileges.can_use_schema, true);
    assert.equal(privileges.can_use_schema_direct, true);
    assert.equal(privileges.can_connect_database, true);
    assert.equal(privileges.can_connect_database_direct, true);
    assert.equal(privileges.no_other_roles_connect, true,
      'no other non-superuser, non-owner role may have CONNECT on the disposable database');
    assert.equal(privileges.no_public_database_grants, true);
    assert.equal(privileges.no_public_schema_create, true,
      'PUBLIC must not be able to create objects in the application schema');
    assert.equal(privileges.no_public_table_grants, true, 'application table privileges must not be granted to PUBLIC');
    assert.equal(privileges.no_public_sequence_grants, true, 'application sequence privileges must not be granted to PUBLIC');
    assert.equal(privileges.no_grant_options, true, 'runtime must not be able to grant privileges onward');
    assert.equal(privileges.not_owner_of_application_objects, true, 'runtime must not own application schema objects');
    assert.equal(privileges.can_read_users_direct, true, 'expected user lookup must be granted directly to runtime');
    assert.equal(privileges.expected_direct_table_privileges, true,
      'runtime must receive each required table privilege directly, without relying on inherited roles');
    assert.equal(privileges.expected_direct_column_privileges, true,
      'runtime must receive only the direct column updates required for password recovery');
    for (const allowed of [
      'can_read_roles', 'can_read_users', 'can_read_categories', 'can_read_products',
      'can_read_media_assets', 'can_read_product_media', 'can_manage_categories',
      'can_manage_products', 'can_manage_media_assets', 'can_manage_product_media',
      'can_insert_audit', 'can_manage_sessions', 'can_manage_login_attempts',
      'can_manage_password_recoveries', 'can_manage_recovery_rate_limits', 'can_update_owner_password_fields',
      'can_use_categories_sequence', 'can_use_products_sequence',
      'can_use_media_assets_sequence', 'can_use_audit_sequence',
      'can_use_categories_sequence_direct', 'can_use_products_sequence_direct',
      'can_use_media_assets_sequence_direct', 'can_use_audit_sequence_direct',
    ]) assert.equal(privileges[allowed], true, `runtime must have ${allowed}`);

    const suffix = randomUUID();
    testEmail = `security-${suffix}@example.invalid`;
    testPassword = randomBytes(32).toString('base64url');
    rateLimitKey = randomBytes(32).toString('hex');
    process.env.EMAIL_ENCRYPTION_KEY = randomBytes(32).toString('hex');
    process.env.EMAIL_LOOKUP_KEY = randomBytes(32).toString('hex');
    process.env.PASSWORD_RECOVERY_KEY = randomBytes(32).toString('hex');
    const emailKeys = getEmailCryptoKeys();
    const ownerEmail = encryptAdminEmail(testEmail, emailKeys);
    testEmailLookupHash = lookupAdminEmail(testEmail, emailKeys.lookupKey);
    const { hashPassword } = await import('../server/passwords.js');
    const passwordHash = await hashPassword(testPassword);
    const ownerRole = await safeSql("SELECT id FROM roles WHERE code = 'owner'");
    assert.equal(ownerRole.rowCount, 1);

    const user = await safeSql(`
      INSERT INTO users (
        role_id, name, email, password_hash,
        email_ciphertext, email_nonce, email_auth_tag, email_lookup_hmac
      ) VALUES ($1, 'Security integration fixture', NULL, $2, $3, $4, $5, $6)
      RETURNING id
    `, [ownerRole.rows[0].id, passwordHash, ownerEmail.email_ciphertext, ownerEmail.email_nonce,
      ownerEmail.email_auth_tag, ownerEmail.email_lookup_hmac]);
    userId = user.rows[0].id;
    const storedEmail = await safeSql(`
      SELECT email, email_ciphertext, email_nonce, email_auth_tag, email_lookup_hmac
      FROM users WHERE id = $1
    `, [userId]);
    assert.equal(storedEmail.rows[0].email, null);
    assert.equal(storedEmail.rows[0].email_ciphertext.includes(testEmail), false);
    assert.equal(decryptAdminEmail(storedEmail.rows[0], emailKeys), testEmail);

    const administratorRole = await safeSql("SELECT id FROM roles WHERE code = 'administrator'");
    assert.equal(administratorRole.rowCount, 1);
    unauthorizedEmail = `non-owner-${suffix}@example.invalid`;
    const administratorEmail = encryptAdminEmail(unauthorizedEmail, emailKeys);
    unauthorizedEmailLookupHash = lookupAdminEmail(unauthorizedEmail, emailKeys.lookupKey);
    const unauthorizedUser = await safeSql(`
      INSERT INTO users (
        role_id, name, email, password_hash,
        email_ciphertext, email_nonce, email_auth_tag, email_lookup_hmac
      ) VALUES ($1, 'Unauthorized integration fixture', NULL, $2, $3, $4, $5, $6)
      RETURNING id
    `, [administratorRole.rows[0].id, passwordHash, administratorEmail.email_ciphertext,
      administratorEmail.email_nonce, administratorEmail.email_auth_tag, administratorEmail.email_lookup_hmac]);
    unauthorizedUserId = unauthorizedUser.rows[0].id;
    unauthorizedSessionToken = randomBytes(32).toString('hex');
    await safeSql(`
      INSERT INTO admin_sessions (session_token_hash, user_id, csrf_token, expires_at)
      VALUES ($1, $2, $3, now() + interval '1 hour')
    `, [createHash('sha256').update(unauthorizedSessionToken).digest('hex'), unauthorizedUserId, randomBytes(32).toString('hex')]);

    fixtureCategorySlug = `security-fixture-${suffix}`;
    const category = await safeSql(`
      INSERT INTO categories (name, slug, description)
      VALUES ($1, $2, 'Disposable security integration fixture')
      RETURNING id
    `, [`Security fixture ${suffix.slice(0, 8)}`, fixtureCategorySlug]);
    categoryId = category.rows[0].id;

    fixtureProductSlug = `security-product-${suffix}`;
    const product = await safeSql(`
      INSERT INTO products (
        category_id, name, slug, description, price, currency,
        measurement_config, pricing_rules, is_published
      ) VALUES ($1, $2, $3, 'Disposable test fixture', 0, 'COP', $4::jsonb, $5::jsonb, TRUE)
      RETURNING id
    `, [
      categoryId,
      `Security fixture ${suffix.slice(0, 8)}`,
      fixtureProductSlug,
      JSON.stringify({ version: 1, dimensions: [{ key: 'width_m', label: 'Ancho', min_m: 0.1, max_m: 5 }] }),
      JSON.stringify({ version: 1, currency: 'COP', expression: { op: 'multiply', args: [{ field: 'width_m' }, { constant: 100 }] } }),
    ]);
    productId = product.rows[0].id;

    process.env.DATABASE_URL = runtimeUrlText;
    process.env.ADMIN_EMAIL = testEmail;
    process.env.ADMIN_RATE_LIMIT_KEY = rateLimitKey;
    process.env.NODE_ENV = 'test';
    const [{ default: app }, database] = await Promise.all([
      import('../server/app.js'),
      import('../server/db.js'),
    ]);
    runtimePool = database.pool;
    server = app.listen(0, expectedHost);
    server.on('connection', (socket) => {
      const address = socket.remoteAddress ?? 'unknown';
      const bucket = createHmac('sha256', Buffer.from(rateLimitKey, 'hex')).update(address).digest('hex');
      ownedRateLimitBuckets.add(bucket);
    });
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    baseUrl = `http://${expectedHost}:${server.address().port}`;
  });

  async function runtimeCheckPrivileges(connectionString, username) {
    const probe = new Pool({ connectionString, max: 1 });
    try {
      return await probe.query(`
        SELECT current_user = $1 AS expected_role,
          has_database_privilege(current_user, current_database(), 'CONNECT') AS can_connect_database,
          has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_database_objects,
          has_database_privilege(current_user, current_database(), 'TEMPORARY') AS can_create_temp_tables,
          EXISTS (
            SELECT 1 FROM pg_database d
            CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) AS acl
            WHERE d.datname = current_database()
              AND acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user)
              AND acl.privilege_type = 'CONNECT'
              AND NOT acl.is_grantable
          ) AS can_connect_database_direct,
          NOT EXISTS (
            SELECT 1 FROM pg_database d
            CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) AS acl
            WHERE d.datname = current_database() AND acl.grantee = 0
          ) AS no_public_database_grants,
          NOT EXISTS (
            SELECT 1 FROM pg_roles r
            WHERE r.rolname NOT IN (
              current_user,
              (SELECT d.datdba::regrole::text FROM pg_database d WHERE d.datname = current_database())
            )
              AND NOT r.rolsuper
              AND has_database_privilege(r.rolname, current_database(), 'CONNECT')
          ) AS no_other_roles_connect,
          has_schema_privilege(current_user, 'public', 'USAGE') AS can_use_schema,
          has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_in_public,
          EXISTS (
            SELECT 1 FROM pg_namespace n
            CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) AS acl
            WHERE n.nspname = 'public'
              AND acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user)
              AND acl.privilege_type = 'USAGE'
          ) AS can_use_schema_direct,
          NOT EXISTS (
            SELECT 1 FROM pg_namespace n
            CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) AS acl
            WHERE n.nspname = 'public' AND acl.grantee = 0
              AND (acl.privilege_type = 'CREATE' OR acl.is_grantable)
          ) AS no_public_schema_create,
          NOT EXISTS (
            SELECT 1 FROM pg_roles r
            WHERE r.rolname <> current_user AND pg_has_role(current_user, r.oid, 'MEMBER')
          ) AS no_role_memberships,
          has_table_privilege(current_user, 'public.users', 'INSERT') AS can_insert_users,
          EXISTS (
            SELECT 1 FROM pg_class c
            CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) AS acl
            WHERE c.oid = 'public.users'::regclass
              AND acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user)
              AND acl.privilege_type = 'SELECT'
          ) AS can_read_users_direct,
          NOT EXISTS (
            SELECT 1
            FROM (VALUES
              ('roles', 'SELECT'), ('users', 'SELECT'),
              ('categories', 'SELECT'), ('categories', 'INSERT'), ('categories', 'UPDATE'), ('categories', 'DELETE'),
              ('products', 'SELECT'), ('products', 'INSERT'), ('products', 'UPDATE'), ('products', 'DELETE'),
              ('media_assets', 'SELECT'), ('media_assets', 'INSERT'), ('media_assets', 'UPDATE'), ('media_assets', 'DELETE'),
              ('product_media', 'SELECT'), ('product_media', 'INSERT'), ('product_media', 'UPDATE'), ('product_media', 'DELETE'),
              ('audit_log', 'INSERT'),
              ('admin_sessions', 'SELECT'), ('admin_sessions', 'INSERT'), ('admin_sessions', 'DELETE'),
              ('admin_login_attempts', 'SELECT'), ('admin_login_attempts', 'INSERT'), ('admin_login_attempts', 'UPDATE'), ('admin_login_attempts', 'DELETE'),
              ('admin_password_recoveries', 'SELECT'), ('admin_password_recoveries', 'INSERT'), ('admin_password_recoveries', 'UPDATE'),
              ('admin_password_recovery_rate_limits', 'SELECT'), ('admin_password_recovery_rate_limits', 'INSERT'),
              ('admin_password_recovery_rate_limits', 'UPDATE'), ('admin_password_recovery_rate_limits', 'DELETE')
            ) AS expected(table_name, privilege_type)
            WHERE NOT EXISTS (
              SELECT 1 FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
              CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) AS acl
              WHERE n.nspname = 'public' AND c.relname = expected.table_name
                AND acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user)
                AND acl.privilege_type = expected.privilege_type
            )
          ) AS expected_direct_table_privileges,
          NOT EXISTS (
            SELECT 1
            FROM (VALUES ('users', 'password_hash', 'UPDATE'), ('users', 'updated_at', 'UPDATE'))
              AS expected(table_name, column_name, privilege_type)
            WHERE NOT EXISTS (
              SELECT 1 FROM pg_attribute a
              JOIN pg_class c ON c.oid = a.attrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
              CROSS JOIN LATERAL aclexplode(a.attacl) AS acl
              WHERE n.nspname = 'public' AND c.relname = expected.table_name
                AND a.attname = expected.column_name AND NOT a.attisdropped
                AND acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user)
                AND acl.privilege_type = expected.privilege_type
            )
          ) AS expected_direct_column_privileges,
          NOT EXISTS (
            SELECT 1 FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) AS acl
            WHERE n.nspname = 'public'
              AND c.relname = ANY(ARRAY['roles', 'users', 'categories', 'products', 'media_assets', 'product_media', 'business_settings', 'audit_log', 'admin_sessions', 'admin_login_attempts', 'admin_password_recoveries', 'admin_password_recovery_rate_limits', 'schema_migrations'])
              AND acl.grantee = 0
          ) AS no_public_table_grants,
          NOT EXISTS (
            SELECT 1 FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('S', c.relowner))) AS acl
            WHERE n.nspname = 'public' AND c.relkind = 'S'
              AND acl.grantee = 0
          ) AS no_public_sequence_grants,
          (NOT EXISTS (
            SELECT 1 FROM pg_database d
            CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) AS acl
            WHERE d.datname = current_database()
              AND acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user)
              AND acl.is_grantable
          ) AND NOT EXISTS (
            SELECT 1 FROM pg_namespace n
            CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) AS acl
            WHERE n.nspname = 'public'
              AND acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user)
              AND acl.is_grantable
          ) AND NOT EXISTS (
            SELECT 1 FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault(
              CASE WHEN c.relkind = 'S' THEN 'S' ELSE 'r' END, c.relowner
            ))) AS acl
            WHERE n.nspname = 'public'
              AND c.relname = ANY(ARRAY['roles', 'users', 'categories', 'products', 'media_assets', 'product_media', 'business_settings', 'audit_log', 'admin_sessions', 'admin_login_attempts', 'admin_password_recoveries', 'admin_password_recovery_rate_limits', 'schema_migrations'])
              AND acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user)
              AND acl.is_grantable
          ) AND NOT EXISTS (
            SELECT 1 FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('S', c.relowner))) AS acl
            WHERE n.nspname = 'public' AND c.relkind = 'S'
              AND acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user)
              AND acl.is_grantable
          )) AS no_grant_options,
          (NOT EXISTS (
             SELECT 1 FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public'
               AND c.relname = ANY(ARRAY['roles', 'users', 'categories', 'products', 'media_assets', 'product_media', 'business_settings', 'audit_log', 'admin_sessions', 'admin_login_attempts', 'admin_password_recoveries', 'admin_password_recovery_rate_limits', 'schema_migrations'])
               AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
           ) AND NOT EXISTS (
             SELECT 1 FROM pg_namespace n
             WHERE n.nspname = 'public'
               AND n.nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
           ) AND NOT EXISTS (
             SELECT 1 FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relkind = 'S'
               AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
           )) AS not_owner_of_application_objects,
          has_table_privilege(current_user, 'public.schema_migrations', 'SELECT') AS can_read_migrations,
          has_table_privilege(current_user, 'public.business_settings', 'SELECT') AS can_read_business_settings,
          NOT (
            has_table_privilege(current_user, 'public.users', 'INSERT')
            OR has_table_privilege(current_user, 'public.users', 'UPDATE')
            OR has_table_privilege(current_user, 'public.users', 'DELETE')
            OR has_table_privilege(current_user, 'public.roles', 'INSERT')
            OR has_table_privilege(current_user, 'public.roles', 'UPDATE')
            OR has_table_privilege(current_user, 'public.roles', 'DELETE')
            OR has_table_privilege(current_user, 'public.audit_log', 'SELECT')
            OR has_table_privilege(current_user, 'public.audit_log', 'UPDATE')
            OR has_table_privilege(current_user, 'public.audit_log', 'DELETE')
            OR has_table_privilege(current_user, 'public.admin_sessions', 'UPDATE')
            OR has_table_privilege(current_user, 'public.business_settings', 'SELECT')
            OR has_table_privilege(current_user, 'public.business_settings', 'INSERT')
            OR has_table_privilege(current_user, 'public.business_settings', 'UPDATE')
            OR has_table_privilege(current_user, 'public.business_settings', 'DELETE')
            OR has_table_privilege(current_user, 'public.schema_migrations', 'SELECT')
            OR has_table_privilege(current_user, 'public.schema_migrations', 'INSERT')
            OR has_table_privilege(current_user, 'public.schema_migrations', 'UPDATE')
            OR has_table_privilege(current_user, 'public.schema_migrations', 'DELETE')
          ) AS no_unneeded_table_write,
          NOT (
            has_table_privilege(current_user, 'public.roles', 'TRUNCATE')
            OR has_table_privilege(current_user, 'public.users', 'TRUNCATE')
            OR has_table_privilege(current_user, 'public.categories', 'TRUNCATE')
            OR has_table_privilege(current_user, 'public.products', 'TRUNCATE')
            OR has_table_privilege(current_user, 'public.media_assets', 'TRUNCATE')
            OR has_table_privilege(current_user, 'public.product_media', 'TRUNCATE')
            OR has_table_privilege(current_user, 'public.business_settings', 'TRUNCATE')
            OR has_table_privilege(current_user, 'public.audit_log', 'TRUNCATE')
            OR has_table_privilege(current_user, 'public.admin_sessions', 'TRUNCATE')
            OR has_table_privilege(current_user, 'public.admin_login_attempts', 'TRUNCATE')
            OR has_table_privilege(current_user, 'public.admin_password_recoveries', 'TRUNCATE')
            OR has_table_privilege(current_user, 'public.admin_password_recovery_rate_limits', 'TRUNCATE')
            OR has_table_privilege(current_user, 'public.schema_migrations', 'TRUNCATE')
          ) AS no_table_truncate,
          NOT (
            has_table_privilege(current_user, 'public.roles', 'REFERENCES') OR has_table_privilege(current_user, 'public.roles', 'TRIGGER')
            OR has_table_privilege(current_user, 'public.users', 'REFERENCES') OR has_table_privilege(current_user, 'public.users', 'TRIGGER')
            OR has_table_privilege(current_user, 'public.categories', 'REFERENCES') OR has_table_privilege(current_user, 'public.categories', 'TRIGGER')
            OR has_table_privilege(current_user, 'public.products', 'REFERENCES') OR has_table_privilege(current_user, 'public.products', 'TRIGGER')
            OR has_table_privilege(current_user, 'public.media_assets', 'REFERENCES') OR has_table_privilege(current_user, 'public.media_assets', 'TRIGGER')
            OR has_table_privilege(current_user, 'public.product_media', 'REFERENCES') OR has_table_privilege(current_user, 'public.product_media', 'TRIGGER')
            OR has_table_privilege(current_user, 'public.business_settings', 'REFERENCES') OR has_table_privilege(current_user, 'public.business_settings', 'TRIGGER')
            OR has_table_privilege(current_user, 'public.audit_log', 'REFERENCES') OR has_table_privilege(current_user, 'public.audit_log', 'TRIGGER')
            OR has_table_privilege(current_user, 'public.admin_sessions', 'REFERENCES') OR has_table_privilege(current_user, 'public.admin_sessions', 'TRIGGER')
            OR has_table_privilege(current_user, 'public.admin_login_attempts', 'REFERENCES') OR has_table_privilege(current_user, 'public.admin_login_attempts', 'TRIGGER')
            OR has_table_privilege(current_user, 'public.admin_password_recoveries', 'REFERENCES') OR has_table_privilege(current_user, 'public.admin_password_recoveries', 'TRIGGER')
            OR has_table_privilege(current_user, 'public.admin_password_recovery_rate_limits', 'REFERENCES') OR has_table_privilege(current_user, 'public.admin_password_recovery_rate_limits', 'TRIGGER')
            OR has_table_privilege(current_user, 'public.schema_migrations', 'REFERENCES') OR has_table_privilege(current_user, 'public.schema_migrations', 'TRIGGER')
          ) AS no_table_reference_or_trigger,
          (has_table_privilege(current_user, 'public.roles', 'INSERT')
            OR has_table_privilege(current_user, 'public.roles', 'UPDATE')
            OR has_table_privilege(current_user, 'public.roles', 'DELETE')) AS can_write_roles,
          has_table_privilege(current_user, 'public.roles', 'SELECT') AS can_read_roles,
          has_table_privilege(current_user, 'public.users', 'SELECT') AS can_read_users,
          has_table_privilege(current_user, 'public.categories', 'SELECT') AS can_read_categories,
          has_table_privilege(current_user, 'public.products', 'SELECT') AS can_read_products,
          has_table_privilege(current_user, 'public.media_assets', 'SELECT') AS can_read_media_assets,
          has_table_privilege(current_user, 'public.product_media', 'SELECT') AS can_read_product_media,
          (has_table_privilege(current_user, 'public.categories', 'INSERT')
            AND has_table_privilege(current_user, 'public.categories', 'UPDATE')
            AND has_table_privilege(current_user, 'public.categories', 'DELETE')) AS can_manage_categories,
          (has_table_privilege(current_user, 'public.products', 'INSERT')
            AND has_table_privilege(current_user, 'public.products', 'UPDATE')
            AND has_table_privilege(current_user, 'public.products', 'DELETE')) AS can_manage_products,
          (has_table_privilege(current_user, 'public.media_assets', 'INSERT')
            AND has_table_privilege(current_user, 'public.media_assets', 'UPDATE')
            AND has_table_privilege(current_user, 'public.media_assets', 'DELETE')) AS can_manage_media_assets,
          (has_table_privilege(current_user, 'public.product_media', 'INSERT')
            AND has_table_privilege(current_user, 'public.product_media', 'UPDATE')
            AND has_table_privilege(current_user, 'public.product_media', 'DELETE')) AS can_manage_product_media,
          has_table_privilege(current_user, 'public.audit_log', 'INSERT') AS can_insert_audit,
          (has_table_privilege(current_user, 'public.admin_sessions', 'SELECT')
            AND has_table_privilege(current_user, 'public.admin_sessions', 'INSERT')
            AND has_table_privilege(current_user, 'public.admin_sessions', 'DELETE')) AS can_manage_sessions,
          (has_table_privilege(current_user, 'public.admin_login_attempts', 'SELECT')
            AND has_table_privilege(current_user, 'public.admin_login_attempts', 'INSERT')
            AND has_table_privilege(current_user, 'public.admin_login_attempts', 'UPDATE')
            AND has_table_privilege(current_user, 'public.admin_login_attempts', 'DELETE')) AS can_manage_login_attempts,
          (has_table_privilege(current_user, 'public.admin_password_recoveries', 'SELECT')
            AND has_table_privilege(current_user, 'public.admin_password_recoveries', 'INSERT')
            AND has_table_privilege(current_user, 'public.admin_password_recoveries', 'UPDATE')) AS can_manage_password_recoveries,
          (has_table_privilege(current_user, 'public.admin_password_recovery_rate_limits', 'SELECT')
            AND has_table_privilege(current_user, 'public.admin_password_recovery_rate_limits', 'INSERT')
            AND has_table_privilege(current_user, 'public.admin_password_recovery_rate_limits', 'UPDATE')
            AND has_table_privilege(current_user, 'public.admin_password_recovery_rate_limits', 'DELETE')) AS can_manage_recovery_rate_limits,
          (has_column_privilege(current_user, 'public.users', 'password_hash', 'UPDATE')
            AND has_column_privilege(current_user, 'public.users', 'updated_at', 'UPDATE')) AS can_update_owner_password_fields,
          has_sequence_privilege(current_user, pg_get_serial_sequence('public.categories', 'id'), 'USAGE') AS can_use_categories_sequence,
          has_sequence_privilege(current_user, pg_get_serial_sequence('public.products', 'id'), 'USAGE') AS can_use_products_sequence,
          has_sequence_privilege(current_user, pg_get_serial_sequence('public.media_assets', 'id'), 'USAGE') AS can_use_media_assets_sequence,
          has_sequence_privilege(current_user, pg_get_serial_sequence('public.audit_log', 'id'), 'USAGE') AS can_use_audit_sequence,
          has_sequence_privilege(current_user, pg_get_serial_sequence('public.users', 'id'), 'USAGE') AS can_use_users_sequence,
          has_sequence_privilege(current_user, pg_get_serial_sequence('public.roles', 'id'), 'USAGE') AS can_use_roles_sequence,
          NOT EXISTS (
            SELECT 1 FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind = 'S'
              AND (has_sequence_privilege(current_user, c.oid, 'SELECT')
                OR has_sequence_privilege(current_user, c.oid, 'UPDATE'))
          ) AS no_sequence_select_or_update,
          NOT EXISTS (
            SELECT 1 FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind = 'S'
              AND has_sequence_privilege(current_user, c.oid, 'USAGE')
              AND NOT EXISTS (
                SELECT 1
                FROM (VALUES
                  (pg_get_serial_sequence('public.categories', 'id')::regclass),
                  (pg_get_serial_sequence('public.products', 'id')::regclass),
                  (pg_get_serial_sequence('public.media_assets', 'id')::regclass),
                  (pg_get_serial_sequence('public.audit_log', 'id')::regclass)
                ) AS allowed(sequence_oid)
                WHERE allowed.sequence_oid = c.oid
              )
          ) AS no_unexpected_sequence_usage,
          EXISTS (
            SELECT 1 FROM pg_class c
            CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('S', c.relowner))) AS acl
            WHERE c.oid = pg_get_serial_sequence('public.categories', 'id')::regclass
              AND acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user)
              AND acl.privilege_type = 'USAGE'
          ) AS can_use_categories_sequence_direct,
          EXISTS (
            SELECT 1 FROM pg_class c
            CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('S', c.relowner))) AS acl
            WHERE c.oid = pg_get_serial_sequence('public.products', 'id')::regclass
              AND acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user)
              AND acl.privilege_type = 'USAGE'
          ) AS can_use_products_sequence_direct,
          EXISTS (
            SELECT 1 FROM pg_class c
            CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('S', c.relowner))) AS acl
            WHERE c.oid = pg_get_serial_sequence('public.media_assets', 'id')::regclass
              AND acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user)
              AND acl.privilege_type = 'USAGE'
          ) AS can_use_media_assets_sequence_direct,
          EXISTS (
            SELECT 1 FROM pg_class c
            CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('S', c.relowner))) AS acl
            WHERE c.oid = pg_get_serial_sequence('public.audit_log', 'id')::regclass
              AND acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user)
              AND acl.privilege_type = 'USAGE'
          ) AS can_use_audit_sequence_direct
      `, [username]);
    } finally {
      await probe.end();
    }
  }

  after(async () => {
    const cleanupErrors = [];
    const attempt = async (label, operation) => {
      try {
        await operation();
      } catch (error) {
        const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code)
          ? error.code
          : (error?.name ?? 'Error');
        cleanupErrors.push(new Error(`${label} falló (código ${code}).`));
      }
    };

    if (server) await attempt('Cerrar servidor HTTP de pruebas', () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }));
    if (runtimePool) await attempt('Cerrar pool runtime', () => runtimePool.end());
    if (setupPool) {
      if (userId) {
        await attempt('Eliminar sesiones del usuario owner de prueba', () => safeSql(
            'DELETE FROM admin_sessions WHERE user_id = $1 OR user_id = (SELECT id FROM users WHERE email_lookup_hmac = $2)',
          [userId, testEmailLookupHash],
        ));
      }
      if (unauthorizedUserId) {
        await attempt('Eliminar sesión del usuario administrador de prueba', () => safeSql(
          'DELETE FROM admin_sessions WHERE user_id = $1 OR user_id = (SELECT id FROM users WHERE email_lookup_hmac = $2)',
          [unauthorizedUserId, unauthorizedEmailLookupHash],
        ));
      }
      if (ownedRateLimitBuckets.size) {
        await attempt('Eliminar buckets de rate limit de sockets de esta ejecución', () => safeSql(
          'DELETE FROM admin_login_attempts WHERE bucket_hash = ANY($1::char(64)[])',
          [[...ownedRateLimitBuckets]],
        ));
      }
      if (userId || testEmail) {
        await attempt('Eliminar auditoría creada por el owner fixture', () => safeSql(
          'DELETE FROM audit_log WHERE actor_user_id = $1 OR actor_user_id = (SELECT id FROM users WHERE email_lookup_hmac = $2)',
          [userId, testEmailLookupHash],
        ));
      }
      for (const slug of createdAdminCategorySlugs) {
        await attempt(`Eliminar categoría de prueba con slug único ${slug}`, () => safeSql('DELETE FROM categories WHERE slug = $1', [slug]));
      }
      if (productId || fixtureProductSlug) await attempt('Eliminar producto fixture', () => safeSql(
        'DELETE FROM products WHERE id = $1 OR slug = $2',
        [productId, fixtureProductSlug],
      ));
      if (categoryId || fixtureCategorySlug) await attempt('Eliminar categoría fixture', () => safeSql(
        'DELETE FROM categories WHERE id = $1 OR slug = $2',
        [categoryId, fixtureCategorySlug],
      ));
      if (userId || testEmail) await attempt('Eliminar usuario owner fixture', () => safeSql(
        'DELETE FROM users WHERE id = $1 OR email_lookup_hmac = $2',
        [userId, testEmailLookupHash],
      ));
      if (unauthorizedUserId || unauthorizedEmail) await attempt('Eliminar usuario administrador fixture', () => safeSql(
        'DELETE FROM users WHERE id = $1 OR email_lookup_hmac = $2',
        [unauthorizedUserId, unauthorizedEmailLookupHash],
      ));
      await attempt('Cerrar pool setup', () => setupPool.end());
    }

    if (cleanupErrors.length) {
      throw new AggregateError(cleanupErrors, 'La limpieza de seguridad falló; revisa cada operación. Los fallos de aserciones se informan por separado por el runner de pruebas.');
    }
  });

  test('server integration: authentication, SQLi, CSRF, quote validation and request limits', { concurrency: false }, async (t) => {
    const unauthenticated = await fetch(`${baseUrl}/api/admin/categories`);
    assert.equal(unauthenticated.status, 401);
    const invalidSession = await fetch(`${baseUrl}/api/admin/categories`, {
      headers: { cookie: `carpinteria_admin_session=${randomBytes(32).toString('hex')}` },
    });
    assert.equal(invalidSession.status, 401);
    const nonOwnerSession = await fetch(`${baseUrl}/api/admin/categories`, {
      headers: { cookie: `carpinteria_admin_session=${unauthorizedSessionToken}` },
    });
    assert.equal(nonOwnerSession.status, 401);
    const unauthenticatedWrite = await fetch(`${baseUrl}/api/admin/categories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Should not be created', slug: 'must-not-exist', pricingRules: null }),
    });
    assert.equal(unauthenticatedWrite.status, 401);
    const loginWithoutCsrf = await fetch(`${baseUrl}/admin/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: testEmail, password: testPassword }),
    });
    assert.equal(loginWithoutCsrf.status, 403);

    const successfulLogin = await login(testEmail, testPassword);
    assert.equal(successfulLogin.response.status, 303);
    const sessionCookie = successfulLogin.cookies.find((value) => value.startsWith('carpinteria_admin_session='));
    assert.ok(sessionCookie, 'valid login should establish an admin session');
    const sessionResponse = await fetch(`${baseUrl}/api/admin/session`, { headers: { cookie: sessionCookie } });
    assert.equal(sessionResponse.status, 200);
    const { csrfToken } = await sessionResponse.json();
    assert.match(csrfToken, /^[a-f0-9]{64}$/);

    await t.test('bad credentials and SQL injection stay unauthenticated with generic responses', async () => {
      const incorrect = await login(testEmail, 'incorrect-password');
      assert.equal(incorrect.response.status, 401);
      assert.match(incorrect.body, /Correo o contraseña incorrectos\./);
      assert.ok(!incorrect.cookies.some((value) => value.startsWith('carpinteria_admin_session=')));

      const injectionEmail = "'/**/OR/**/'1'='1'--@example.invalid";
      const injection = await login(injectionEmail, 'irrelevant-password');
      assert.equal(injection.response.status, 401);
      assert.match(injection.body, /Correo o contraseña incorrectos\./);
      assert.ok(!injection.cookies.some((value) => value.startsWith('carpinteria_admin_session=')));
      assert.doesNotMatch(injection.body, /syntax error|SELECT\s|password_hash|stack/i);
    });

    await t.test('admin CSRF blocks writes without token and permits a legitimate protected mutation', async () => {
      const sqlLikeName = "Madera'); SELECT 'sql-like text'; --";
      const payload = { name: sqlLikeName, slug: `authorized-${randomUUID()}`, pricingRules: null };
      createdAdminCategorySlugs.add(payload.slug);
      const denied = await fetch(`${baseUrl}/api/admin/categories`, {
        method: 'POST',
        headers: { cookie: sessionCookie, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      assert.equal(denied.status, 403);

      const allowed = await fetch(`${baseUrl}/api/admin/categories`, {
        method: 'POST',
        headers: { cookie: sessionCookie, 'content-type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify(payload),
      });
      assert.equal(allowed.status, 201);
      const allowedBody = await allowed.json();
      assert.equal(allowedBody.category.name, sqlLikeName, 'SQL-looking input should be stored as a literal value');

      const injectedId = encodeURIComponent("1' OR '1'='1 --");
      const pathInjection = await fetch(`${baseUrl}/api/admin/categories/${injectedId}`, {
        method: 'PATCH',
        headers: { cookie: sessionCookie, 'content-type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({}),
      });
      assert.equal(pathInjection.status, 400);
    });

    await t.test('catalog and quotation endpoint accept valid measurements and reject malformed data', async () => {
      const catalog = await fetch(`${baseUrl}/api/catalog`);
      assert.equal(catalog.status, 200);
      const catalogBody = await catalog.json();
      assert.ok(catalogBody.products.some((product) => String(product.id) === String(productId)));

      const valid = await fetch(`${baseUrl}/api/catalog/${productId}/estimate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ measurements: { width_m: 2.5 } }),
      });
      assert.equal(valid.status, 200);
      assert.deepEqual(await valid.json(), { status: 'estimated', amount: 250, currency: 'COP' });

      const invalid = await fetch(`${baseUrl}/api/catalog/${productId}/estimate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ measurements: { width_m: -1 } }),
      });
      assert.equal(invalid.status, 422);

      const injectedId = encodeURIComponent("1' OR '1'='1 --");
      const pathInjection = await fetch(`${baseUrl}/api/catalog/${injectedId}/estimate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ measurements: { width_m: 2.5 } }),
      });
      assert.equal(pathInjection.status, 400);
    });

    await t.test('malformed, compressed and oversized request bodies are rejected without leaking internals', async () => {
      const malformedJson = await fetch(`${baseUrl}/api/catalog/${productId}/estimate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"measurements":',
      });
      assert.equal(malformedJson.status, 400);
      assert.deepEqual(await malformedJson.json(), { error: 'El cuerpo de la solicitud no contiene datos válidos.' });

      const compressed = await fetch(`${baseUrl}/api/catalog/${productId}/estimate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
        body: gzipSync(Buffer.from(JSON.stringify({ measurements: { width_m: 1 } }))),
      });
      assert.equal(compressed.status, 415);
      const compressedBody = await compressed.json();
      assert.deepEqual(compressedBody, { error: 'La codificación del cuerpo no está admitida.' });
      assert.doesNotMatch(JSON.stringify(compressedBody), /stack|node_modules|postgres|SELECT\s/i);

      const oversized = await fetch(`${baseUrl}/api/catalog/${productId}/estimate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ measurements: { width_m: 1 }, padding: 'x'.repeat(40_000) }),
      });
      assert.equal(oversized.status, 413);
      assert.doesNotMatch(await oversized.text(), /stack|node_modules|postgres|SELECT\s/i);
    });

    await t.test('administration search treats SQL-like input as a search value', async () => {
      const queryValue = encodeURIComponent("%' OR 1=1 --");
      const response = await fetch(`${baseUrl}/api/admin/media/library?q=${queryValue}`, {
        headers: { cookie: sessionCookie },
      });
      assert.equal(response.status, 200);
      assert.ok(Array.isArray((await response.json()).media));
    });

    await t.test('login attempt limit rejects the sixth failure despite forged forwarded IP headers', async () => {
      const reset = await login(testEmail, testPassword);
      assert.equal(reset.response.status, 303);
      const results = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        results.push(await login(testEmail, `wrong-password-${attempt}`, `198.51.100.${attempt + 1}`));
      }
      assert.deepEqual(results.slice(0, 5).map(({ response }) => response.status), [401, 401, 401, 401, 401]);
      assert.equal(results[5].response.status, 429);
      assert.match(results[5].body, /Se alcanzó el límite de intentos/);
    });
  });
}
