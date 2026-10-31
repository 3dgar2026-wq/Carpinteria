import pg from 'pg';
import {
  decryptAdminEmail,
  encryptAdminEmail,
  getEmailCryptoKeys,
  normalizeAdminEmail,
} from '../server/admin-email-crypto.js';

const { Client } = pg;
const expectedDatabase = 'carpinteria_db';
const args = process.argv.slice(2);

if (args.length !== 2 || args[0] !== '--database' || args[1] !== expectedDatabase) {
  console.error('Uso: node scripts/encrypt-admin-emails.js --database carpinteria_db');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('Falta DATABASE_URL.');
  process.exit(1);
}

let keys;
try {
  keys = getEmailCryptoKeys();
} catch {
  console.error('EMAIL_ENCRYPTION_KEY y EMAIL_LOOKUP_KEY deben estar configuradas correctamente.');
  process.exit(1);
}

const client = new Client({ connectionString: process.env.DATABASE_URL });
let inTransaction = false;

try {
  await client.connect();
  const { rows: databaseRows } = await client.query('SELECT current_database() AS name');
  if (databaseRows[0]?.name !== expectedDatabase) throw new Error('unexpected_database');

  await client.query('BEGIN');
  inTransaction = true;
  await client.query('LOCK TABLE users IN ACCESS EXCLUSIVE MODE');
  const { rows } = await client.query(`
    SELECT id, email, email_ciphertext, email_nonce, email_auth_tag, email_lookup_hmac
    FROM users
    ORDER BY id
  `);

  for (const row of rows) {
    const hasAnyEncryptedField = row.email_ciphertext !== null || row.email_nonce !== null
      || row.email_auth_tag !== null || row.email_lookup_hmac !== null;
    const hasAllEncryptedFields = row.email_ciphertext !== null && row.email_nonce !== null
      && row.email_auth_tag !== null && row.email_lookup_hmac !== null;
    if (hasAnyEncryptedField && !hasAllEncryptedFields) throw new Error('partial_encryption');

    if (row.email !== null) {
      const normalized = normalizeAdminEmail(row.email);
      if (!normalized) throw new Error('invalid_legacy_email');
      if (!hasAnyEncryptedField) {
        const encrypted = encryptAdminEmail(normalized, keys);
        await client.query(`
          UPDATE users
          SET email_ciphertext = $2, email_nonce = $3, email_auth_tag = $4, email_lookup_hmac = $5
          WHERE id = $1
        `, [row.id, encrypted.email_ciphertext, encrypted.email_nonce, encrypted.email_auth_tag, encrypted.email_lookup_hmac]);
        Object.assign(row, encrypted);
      } else if (decryptAdminEmail(row, keys) !== normalized) {
        throw new Error('legacy_email_mismatch');
      }
    } else if (!hasAllEncryptedFields) {
      throw new Error('missing_email');
    }

    const decrypted = decryptAdminEmail(row, keys);
    if (row.email !== null && decrypted !== normalizeAdminEmail(row.email)) {
      throw new Error('email_verification_failed');
    }
  }

  const { rows: remainingRows } = await client.query(`
    SELECT id, email, email_ciphertext, email_nonce, email_auth_tag, email_lookup_hmac
    FROM users
    ORDER BY id
  `);
  for (const row of remainingRows) {
    if (!row.email_ciphertext || !row.email_nonce || !row.email_auth_tag || !row.email_lookup_hmac) {
      throw new Error('incomplete_encryption');
    }
    const decrypted = decryptAdminEmail(row, keys);
    if (row.email !== null && decrypted !== normalizeAdminEmail(row.email)) {
      throw new Error('email_verification_failed');
    }
  }

  await client.query('UPDATE users SET email = NULL WHERE email IS NOT NULL');
  await client.query(`
    ALTER TABLE users
      ALTER COLUMN email_ciphertext SET NOT NULL,
      ALTER COLUMN email_nonce SET NOT NULL,
      ALTER COLUMN email_auth_tag SET NOT NULL,
      ALTER COLUMN email_lookup_hmac SET NOT NULL
  `);
  await client.query('COMMIT');
  inTransaction = false;
  console.log(`Correos cifrados y verificados: ${remainingRows.length}.`);
} catch {
  if (inTransaction) await client.query('ROLLBACK').catch(() => {});
  console.error('No se completó la migración protegida de correos; los cambios de esta ejecución se revirtieron.');
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
