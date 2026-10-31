import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { hashPassword, verifyPassword } from '../server/passwords.js';

test('passwords use unique scrypt salts and reject invalid encodings', async () => {
  const password = 'carpinteria-test-password-only';
  const firstHash = await hashPassword(password);
  const secondHash = await hashPassword(password);

  assert.ok(firstHash !== secondHash, 'each password hash should use a fresh random salt');
  assert.equal(firstHash.includes(password), false);
  assert.equal(await verifyPassword(password, firstHash), true);
  assert.equal(await verifyPassword('incorrect-test-password', firstHash), false);

  const parts = firstHash.split('$');
  const invalidSalt = [...parts];
  invalidSalt[4] += '!';
  const invalidDigest = [...parts];
  invalidDigest[5] += '!';
  const paddedDigest = [...parts];
  paddedDigest[5] += '=';

  for (const malformed of [
    null,
    '',
    firstHash.replace('scrypt$', 'argon2id$'),
    firstHash.replace('$131072$', '$1024$'),
    invalidSalt.join('$'),
    invalidDigest.join('$'),
    paddedDigest.join('$'),
  ]) {
    assert.equal(await verifyPassword(password, malformed), false);
  }
});

test('admin API source does not expose password fields or hashes', async () => {
  const source = await readFile(new URL('../server/admin-api.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /password(?:_hash|Hash)?/i);
});
