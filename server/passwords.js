import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
export const passwordParameters = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

function decodeBase64url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.toString('base64url') === value ? decoded : null;
}

export async function hashPassword(password, salt = randomBytes(16)) {
  const derived = await scrypt(password, salt, 64, passwordParameters);
  return `scrypt$${passwordParameters.N}$${passwordParameters.r}$${passwordParameters.p}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password, encodedHash) {
  const parts = typeof encodedHash === 'string' ? encodedHash.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt'
    || parts[1] !== String(passwordParameters.N)
    || parts[2] !== String(passwordParameters.r)
    || parts[3] !== String(passwordParameters.p)) return false;

  try {
    const salt = decodeBase64url(parts[4]);
    const expected = decodeBase64url(parts[5]);
    if (!salt || !expected || salt.length !== 16 || expected.length !== 64) return false;
    const actual = await scrypt(password, salt, expected.length, passwordParameters);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
