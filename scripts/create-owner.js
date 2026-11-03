import { timingSafeEqual } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import pg from 'pg';
import { hashPassword } from '../server/passwords.js';
import {
  encryptAdminEmail,
  getEmailCryptoKeys,
  getRecoveryCodeKey,
  lookupAdminEmail,
} from '../server/admin-email-crypto.js';
import { isValidConfiguredAdminEmail, validateOwnerBootstrapInput } from './owner-bootstrap-validation.js';

const { Client } = pg;
const args = process.argv.slice(2);
const expectedDatabase = args[1];
const email = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();

if (args.length !== 2 || args[0] !== '--database' || !/^[a-z_][a-z0-9_]{0,62}$/i.test(expectedDatabase ?? '')) {
  console.error('Uso: npm run admin:create-owner -- --database <nombre-exacto>');
  process.exit(1);
}
const directConnectionString = process.env.DATABASE_URL_UNPOOLED;
const applicationConnectionString = process.env.DATABASE_URL;
const connectionString = directConnectionString || applicationConnectionString;

function isPooledConnectionString(value) {
  try {
    return /-pooler\./i.test(new URL(value).hostname);
  } catch {
    return false;
  }
}

if (!connectionString) {
  console.error('Falta DATABASE_URL_UNPOOLED o DATABASE_URL. Configura el entorno antes de crear al propietario.');
  process.exit(1);
}
if ((directConnectionString && isPooledConnectionString(directConnectionString))
  || (!directConnectionString && isPooledConnectionString(applicationConnectionString))) {
  console.error('La creación del propietario requiere la conexión directa de Neon en DATABASE_URL_UNPOOLED.');
  process.exit(1);
}
if (!isValidConfiguredAdminEmail(email)) {
  console.error('Define un ADMIN_EMAIL válido en el entorno antes de crear la cuenta.');
  process.exit(1);
}
let emailKeys;
let recoveryKey;
try {
  emailKeys = getEmailCryptoKeys();
  recoveryKey = getRecoveryCodeKey();
} catch {
  console.error('Configura correctamente las claves de correo y recuperación antes de crear la cuenta.');
  process.exit(1);
}
const configuredRateKey = process.env.ADMIN_RATE_LIMIT_KEY ?? '';
if (!/^[a-f0-9]{64,}$/i.test(configuredRateKey) || configuredRateKey.length % 2 !== 0) {
  console.error('Define ADMIN_RATE_LIMIT_KEY como una clave hexadecimal válida de al menos 32 bytes.');
  process.exit(1);
}
const rateLimitKey = Buffer.from(configuredRateKey, 'hex');
if (rateLimitKey.equals(emailKeys.encryptionKey) || rateLimitKey.equals(emailKeys.lookupKey)
  || rateLimitKey.equals(recoveryKey)) {
  console.error('ADMIN_RATE_LIMIT_KEY debe ser independiente de las claves de correo y recuperación.');
  process.exit(1);
}
const encryptedEmail = encryptAdminEmail(email, emailKeys);
const emailLookupHash = lookupAdminEmail(email, emailKeys.lookupKey);

function promptHidden(label) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    return Promise.reject(new Error('Se requiere una terminal interactiva para introducir la contraseña de forma segura.'));
  }

  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    let value = '';
    stdout.write(label);
    stdin.setRawMode(true);
    stdin.resume();

    const finish = (error) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };

    const onData = (chunk) => {
      for (const character of decoder.write(chunk)) {
        if (character === '\u0003' || character === '\u0004') {
          finish(new Error('Operación cancelada.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish();
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = Array.from(value).slice(0, -1).join('');
        } else if (character >= ' ') {
          value += character;
        }
      }
    };

    stdin.on('data', onData);
  });
}

let name;
let password;
let confirmation;
const prompts = createInterface({ input: stdin, output: stdout });
try {
  name = (await prompts.question('Nombre del propietario: ')).trim();
} finally {
  prompts.close();
}

try {
  password = await promptHidden('Contraseña (mínimo 12 caracteres): ');
  confirmation = await promptHidden('Repite la contraseña: ');
} catch {
  console.error('No se pudo leer la contraseña de forma segura. No se creó ninguna cuenta.');
  process.exit(1);
}

const inputDiagnostics = validateOwnerBootstrapInput({ name, email, password });
if (inputDiagnostics.length > 0) {
  console.error(`No se creó ninguna cuenta. Validaciones: ${inputDiagnostics.join(', ')}.`);
  process.exit(1);
}
const passwordBuffer = Buffer.from(password);
const confirmationBuffer = Buffer.from(confirmation);
if (passwordBuffer.length !== confirmationBuffer.length || !timingSafeEqual(passwordBuffer, confirmationBuffer)) {
  console.error('Las contraseñas no coinciden. No se creó ninguna cuenta.');
  process.exit(1);
}

const client = new Client({ connectionString });
let stage = 'connection';
try {
  await client.connect();

  stage = 'database-check';
  const { rows: databaseRows } = await client.query('SELECT current_database() AS name, current_schema() AS schema_name');
  if (databaseRows[0]?.name !== expectedDatabase) throw Object.assign(new Error('Database mismatch'), { code: 'DATABASE_MISMATCH' });
  if (databaseRows[0]?.schema_name !== 'public') throw Object.assign(new Error('Schema mismatch'), { code: 'SCHEMA_MISMATCH' });

  stage = 'transaction-start';
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(104713, 1)');

  stage = 'schema-check';
  const { rows: schemaRows } = await client.query(`
    SELECT to_regclass('public.users') AS users,
           to_regclass('public.roles') AS roles,
           to_regclass('public.audit_log') AS audit_log,
           to_regclass('public.admin_sessions') AS admin_sessions,
            to_regclass('public.admin_login_attempts') AS admin_login_attempts,
            to_regclass('public.admin_password_recoveries') AS password_recoveries,
            to_regclass('public.admin_password_recovery_rate_limits') AS recovery_rate_limits,
            to_regclass('public.schema_migrations') AS schema_migrations
  `);
  if (!schemaRows[0]?.users || !schemaRows[0]?.roles || !schemaRows[0]?.audit_log
    || !schemaRows[0]?.admin_sessions || !schemaRows[0]?.admin_login_attempts
    || !schemaRows[0]?.password_recoveries || !schemaRows[0]?.recovery_rate_limits
    || !schemaRows[0]?.schema_migrations) {
    throw Object.assign(new Error('Schema incomplete'), { code: 'BOOTSTRAP_SCHEMA_INCOMPLETE' });
  }

  stage = 'migration-check';
  const expectedMigrations = [
    '001_initial_schema.sql',
    '002_catalog_configuration.sql',
    '003_admin_auth.sql',
    '004_category_measurement_templates.sql',
    '005_private_media_inbox.sql',
    '006_admin_email_encryption_password_recovery.sql',
  ];
  const { rows: migrationRows } = await client.query(
    'SELECT name FROM public.schema_migrations WHERE name = ANY($1::text[])',
    [expectedMigrations],
  );
  if (migrationRows.length !== expectedMigrations.length) {
    throw Object.assign(new Error('Required migrations missing'), { code: 'REQUIRED_MIGRATIONS_MISSING' });
  }

  stage = 'existing-users-check';
  const { rows: userCountRows } = await client.query('SELECT count(*)::integer AS total FROM public.users');
  if (userCountRows[0]?.total !== 0) throw Object.assign(new Error('Users already exist'), { code: 'USERS_ALREADY_EXIST' });

  stage = 'email-check';
  const { rows: emailRows } = await client.query(
    'SELECT 1 FROM users WHERE email_lookup_hmac = $1 LIMIT 1',
    [emailLookupHash],
  );
  if (emailRows.length) throw Object.assign(new Error('Configured admin email already exists'), { code: 'ADMIN_EMAIL_ALREADY_EXISTS' });

  stage = 'owner-role-check';
  const { rows: roleRows } = await client.query("SELECT id FROM roles WHERE code = 'owner'");
  if (!roleRows.length) throw Object.assign(new Error('Owner role missing'), { code: 'OWNER_ROLE_MISSING' });

  stage = 'password-hash';
  const hash = await hashPassword(password);

  stage = 'user-insert';
  const { rows: userRows } = await client.query(`
    INSERT INTO users (
      role_id, name, email, password_hash,
      email_ciphertext, email_nonce, email_auth_tag, email_lookup_hmac
    ) VALUES ($1, $2, NULL, $3, $4, $5, $6, $7)
    RETURNING id
  `, [roleRows[0].id, name, hash, encryptedEmail.email_ciphertext, encryptedEmail.email_nonce,
    encryptedEmail.email_auth_tag, encryptedEmail.email_lookup_hmac]);

  stage = 'audit-insert';
  await client.query(`
    INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, result, details)
    VALUES ($1, 'owner.bootstrap.created', 'user', $2, 'success', '{"method":"controlled_cli"}'::jsonb)
  `, [userRows[0].id, String(userRows[0].id)]);

  stage = 'commit';
  await client.query('COMMIT');
  console.log(`Cuenta propietaria creada en ${expectedDatabase}. Guarda la contraseña en un gestor seguro.`);
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  const safeCode = typeof error?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code)
    ? error.code
    : 'NO_CODE';
  console.error(`No se creó la cuenta. etapa=${stage} codigo=${safeCode}`);
  process.exitCode = 1;
} finally {
  if (passwordBuffer) passwordBuffer.fill(0);
  if (confirmationBuffer) confirmationBuffer.fill(0);
  password = '';
  confirmation = '';
  await client.end().catch(() => {});
}
