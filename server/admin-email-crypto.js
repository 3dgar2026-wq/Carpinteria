import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

const emailAad = Buffer.from('carpinteria-admin-email:v1');
const keyPattern = /^[a-f0-9]{64}$/i;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readKey(value, name) {
  if (typeof value !== 'string' || !keyPattern.test(value)) {
    throw new Error(`${name} debe contener 32 bytes en hexadecimal.`);
  }
  return Buffer.from(value, 'hex');
}

export function getEmailCryptoKeys(env = process.env) {
  const encryptionKey = readKey(env.EMAIL_ENCRYPTION_KEY, 'EMAIL_ENCRYPTION_KEY');
  const lookupKey = readKey(env.EMAIL_LOOKUP_KEY, 'EMAIL_LOOKUP_KEY');
  if (encryptionKey.equals(lookupKey)) {
    throw new Error('EMAIL_ENCRYPTION_KEY y EMAIL_LOOKUP_KEY deben ser independientes.');
  }
  return { encryptionKey, lookupKey };
}

export function getRecoveryCodeKey(env = process.env) {
  const recoveryKey = readKey(env.PASSWORD_RECOVERY_KEY, 'PASSWORD_RECOVERY_KEY');
  const emailKeys = getEmailCryptoKeys(env);
  if (recoveryKey.equals(emailKeys.encryptionKey) || recoveryKey.equals(emailKeys.lookupKey)) {
    throw new Error('PASSWORD_RECOVERY_KEY debe ser independiente de las claves de correo.');
  }
  const configuredRateKey = env.ADMIN_RATE_LIMIT_KEY ?? '';
  if (keyPattern.test(configuredRateKey) && recoveryKey.equals(Buffer.from(configuredRateKey, 'hex'))) {
    throw new Error('PASSWORD_RECOVERY_KEY debe ser independiente de ADMIN_RATE_LIMIT_KEY.');
  }
  return recoveryKey;
}

export function normalizeAdminEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && emailPattern.test(email) ? email : null;
}

export function lookupAdminEmail(email, lookupKey) {
  const normalized = normalizeAdminEmail(email);
  if (!normalized || !Buffer.isBuffer(lookupKey) || lookupKey.length !== 32) {
    throw new Error('No se pudo calcular el índice de correo.');
  }
  return createHmac('sha256', lookupKey)
    .update('carpinteria-admin-email:v1\0')
    .update(normalized)
    .digest('hex');
}

export function encryptAdminEmail(email, keys = getEmailCryptoKeys()) {
  const normalized = normalizeAdminEmail(email);
  if (!normalized) throw new Error('El correo no tiene un formato válido.');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keys.encryptionKey, nonce);
  cipher.setAAD(emailAad);
  const ciphertext = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final()]);
  return {
    email_ciphertext: ciphertext.toString('base64url'),
    email_nonce: nonce.toString('base64url'),
    email_auth_tag: cipher.getAuthTag().toString('base64url'),
    email_lookup_hmac: lookupAdminEmail(normalized, keys.lookupKey),
  };
}

function decodeBase64url(value, expectedLength) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url');
  return (expectedLength === null || decoded.length === expectedLength)
    && decoded.toString('base64url') === value ? decoded : null;
}

export function decryptAdminEmail(record, keys = getEmailCryptoKeys()) {
  const ciphertext = decodeBase64url(record?.email_ciphertext, null);
  const nonce = decodeBase64url(record?.email_nonce, 12);
  const authTag = decodeBase64url(record?.email_auth_tag, 16);
  if (!ciphertext || !nonce || !authTag || !/^[a-f0-9]{64}$/i.test(record?.email_lookup_hmac ?? '')) {
    throw new Error('El correo cifrado tiene un formato inválido.');
  }
  const decipher = createDecipheriv('aes-256-gcm', keys.encryptionKey, nonce);
  decipher.setAAD(emailAad);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  const normalized = normalizeAdminEmail(plaintext);
  if (!normalized || normalized !== plaintext
    || lookupAdminEmail(normalized, keys.lookupKey) !== record.email_lookup_hmac.toLowerCase()) {
    throw new Error('El correo cifrado no pasó su comprobación de integridad.');
  }
  return normalized;
}

export function hmacRecoveryCode(userId, code, key) {
  return createHmac('sha256', key)
    .update('carpinteria-password-recovery:v1\0')
    .update(String(userId))
    .update('\0')
    .update(code)
    .digest('hex');
}

export function hmacRecoveryIp(address, key) {
  return createHmac('sha256', key)
    .update('carpinteria-password-recovery-ip:v1\0')
    .update(address || 'unknown')
    .digest('hex');
}

export function hashResetGrant(token) {
  return createHash('sha256')
    .update(token)
    .digest('hex');
}
