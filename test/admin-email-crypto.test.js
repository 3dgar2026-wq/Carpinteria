import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  decryptAdminEmail,
  encryptAdminEmail,
  getEmailCryptoKeys,
  lookupAdminEmail,
} from '../server/admin-email-crypto.js';

function makeKeys() {
  return getEmailCryptoKeys({
    EMAIL_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    EMAIL_LOOKUP_KEY: randomBytes(32).toString('hex'),
  });
}

test('administrator email is encrypted, indexed by HMAC, and authenticated', () => {
  const keys = makeKeys();
  const email = 'Owner.Example@example.invalid';
  const first = encryptAdminEmail(email, keys);
  const second = encryptAdminEmail(email, keys);

  assert.equal(decryptAdminEmail(first, keys), email.toLowerCase());
  assert.equal(first.email_lookup_hmac, lookupAdminEmail(email, keys.lookupKey));
  assert.equal(first.email_lookup_hmac, second.email_lookup_hmac);
  assert.ok(first.email_nonce !== second.email_nonce, 'each encryption should use a fresh nonce');
  assert.equal(first.email_ciphertext.includes('owner.example'), false);

  const wrongKeys = { encryptionKey: randomBytes(32), lookupKey: keys.lookupKey };
  assert.throws(() => decryptAdminEmail(first, wrongKeys));
  assert.throws(() => decryptAdminEmail(first, { encryptionKey: keys.encryptionKey, lookupKey: randomBytes(32) }));

  const tampered = { ...first, email_ciphertext: `${first.email_ciphertext.slice(0, -1)}${first.email_ciphertext.endsWith('A') ? 'B' : 'A'}` };
  assert.throws(() => decryptAdminEmail(tampered, keys));
  assert.throws(() => decryptAdminEmail({ ...first, email_auth_tag: 'invalid' }, keys));
});

test('email encryption and lookup keys must be 32-byte independent values', () => {
  const sameKey = randomBytes(32).toString('hex');
  assert.throws(() => getEmailCryptoKeys({ EMAIL_ENCRYPTION_KEY: sameKey, EMAIL_LOOKUP_KEY: sameKey }));
  assert.throws(() => getEmailCryptoKeys({ EMAIL_ENCRYPTION_KEY: 'short', EMAIL_LOOKUP_KEY: randomBytes(32).toString('hex') }));
});
