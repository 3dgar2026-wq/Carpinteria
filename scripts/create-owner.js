import { timingSafeEqual } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import pg from 'pg';
import { hashPassword } from '../server/passwords.js';
import { encryptAdminEmail, getEmailCryptoKeys, lookupAdminEmail } from '../server/admin-email-crypto.js';

const { Client } = pg;
const expectedDatabase = 'carpinteria_db';
const args = process.argv.slice(2);
const email = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

if (args.length !== 2 || args[0] !== '--database' || args[1] !== expectedDatabase) {
  console.error('Uso: npm run admin:create-owner -- --database carpinteria_db');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('Falta DATABASE_URL. Configura el entorno antes de crear al propietario.');
  process.exit(1);
}
if (!emailPattern.test(email) || email.length > 254) {
  console.error('Define un ADMIN_EMAIL válido en el entorno antes de crear la cuenta.');
  process.exit(1);
}
let emailKeys;
try {
  emailKeys = getEmailCryptoKeys();
} catch {
  console.error('Define EMAIL_ENCRYPTION_KEY y EMAIL_LOOKUP_KEY antes de crear la cuenta.');
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

if (!name || name.length > 160 || !emailPattern.test(email) || email.length > 254
  || Array.from(password).length < 12 || Buffer.byteLength(password) > 256) {
  console.error('Revisa ADMIN_EMAIL, el nombre y la longitud de la contraseña. No se creó ninguna cuenta.');
  process.exit(1);
}
const passwordBuffer = Buffer.from(password);
const confirmationBuffer = Buffer.from(confirmation);
if (passwordBuffer.length !== confirmationBuffer.length || !timingSafeEqual(passwordBuffer, confirmationBuffer)) {
  console.error('Las contraseñas no coinciden. No se creó ninguna cuenta.');
  process.exit(1);
}

const client = new Client({ connectionString: process.env.DATABASE_URL });
let stage = 'connection';
try {
  await client.connect();

  stage = 'database-check';
  const { rows: databaseRows } = await client.query('SELECT current_database() AS name');
  if (databaseRows[0]?.name !== expectedDatabase) throw new Error('Base de datos distinta');

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
            to_regclass('public.admin_password_recoveries') AS password_recoveries
  `);
  if (!schemaRows[0]?.users || !schemaRows[0]?.roles || !schemaRows[0]?.audit_log
    || !schemaRows[0]?.admin_sessions || !schemaRows[0]?.admin_login_attempts
    || !schemaRows[0]?.password_recoveries) {
    throw new Error('Esquema incompleto');
  }

  stage = 'email-check';
  const { rows: emailRows } = await client.query(
    'SELECT 1 FROM users WHERE email_lookup_hmac = $1 LIMIT 1',
    [emailLookupHash],
  );
  if (emailRows.length) throw new Error('El correo ya existe');

  stage = 'owner-role-check';
  const { rows: roleRows } = await client.query("SELECT id FROM roles WHERE code = 'owner'");
  if (!roleRows.length) throw new Error('No existe el rol propietario');

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
