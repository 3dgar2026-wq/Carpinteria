import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { encryptAdminEmail, getEmailCryptoKeys, lookupAdminEmail } from '../server/admin-email-crypto.js';
import { createAdminPasswordRecoveryHandlers } from '../server/admin-password-recovery.js';
import { hashPassword, verifyPassword } from '../server/passwords.js';

const targetEmail = 'owner@example.invalid';

function makeEnvironment() {
  return {
    ADMIN_EMAIL: targetEmail,
    ADMIN_RATE_LIMIT_KEY: randomBytes(32).toString('hex'),
    EMAIL_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    EMAIL_LOOKUP_KEY: randomBytes(32).toString('hex'),
    PASSWORD_RECOVERY_KEY: randomBytes(32).toString('hex'),
    SMTP_USER: 'mailer@example.invalid',
    NODE_ENV: 'test',
  };
}

class FakeRecoveryPool {
  constructor(env) {
    const keys = getEmailCryptoKeys(env);
    this.user = {
      id: 7,
      active: true,
      role: 'owner',
      ...encryptAdminEmail(targetEmail, keys),
      password_hash: 'previous-hash',
    };
    this.lookupHash = lookupAdminEmail(targetEmail, keys.lookupKey);
    this.recovery = null;
    this.rateBuckets = new Map();
    this.sessions = [7, 7];
  }

  async connect() {
    return { query: (sql, params = []) => this.query(sql, params), release() {} };
  }

  async query(sql, params = []) {
    const statement = sql.replace(/\s+/g, ' ').trim();
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(statement)) return { rows: [], rowCount: 0 };
    if (statement.startsWith('DELETE FROM admin_password_recovery_rate_limits')) return { rows: [], rowCount: 0 };
    if (statement.startsWith('INSERT INTO admin_password_recovery_rate_limits')) {
      const [scope, bucketHash, maximum] = params;
      const key = `${scope}:${bucketHash}`;
      const bucket = this.rateBuckets.get(key) ?? { count: 0 };
      bucket.count = Math.min(bucket.count + 1, maximum + 1);
      this.rateBuckets.set(key, bucket);
      return { rows: [{ attempt_count: bucket.count }], rowCount: 1 };
    }
    if (statement.startsWith('SELECT id, email_ciphertext')) {
      return { rows: this.user.active && this.user.role === 'owner' && params[0] === this.lookupHash ? [this.user] : [], rowCount: 1 };
    }
    if (statement.startsWith('INSERT INTO admin_password_recoveries')) {
      const [userId, codeHash] = params;
      this.recovery = {
        user_id: userId,
        code_hmac: codeHash,
        expires_at: new Date(Date.now() + 10 * 60 * 1000),
        attempt_count: 0,
        verified_at: null,
        reset_token_hash: null,
        reset_token_expires_at: null,
        consumed_at: null,
      };
      return { rows: [], rowCount: 1 };
    }
    if (statement.startsWith('SELECT r.user_id, r.code_hmac')) {
      const found = this.recovery && params[0] === this.lookupHash ? [this.recovery] : [];
      return { rows: found, rowCount: found.length };
    }
    if (statement.startsWith('UPDATE admin_password_recoveries SET attempt_count')) {
      this.recovery.attempt_count = params[1];
      if (params[1] >= params[2]) this.recovery.code_hmac = null;
      return { rows: [], rowCount: 1 };
    }
    if (statement.startsWith('UPDATE admin_password_recoveries SET code_hmac = NULL, attempt_count')) {
      this.recovery.code_hmac = null;
      this.recovery.attempt_count = params[1];
      this.recovery.verified_at = new Date();
      this.recovery.reset_token_hash = params[2];
      this.recovery.reset_token_expires_at = new Date(Date.now() + 10 * 60 * 1000);
      return { rows: [], rowCount: 1 };
    }
    if (statement.startsWith('SELECT user_id FROM admin_password_recoveries')) {
      const valid = this.recovery && this.recovery.reset_token_hash === params[0]
        && this.recovery.reset_token_expires_at > new Date() && !this.recovery.consumed_at;
      return { rows: valid ? [{ user_id: this.user.id }] : [], rowCount: valid ? 1 : 0 };
    }
    if (statement.startsWith('SELECT r.user_id FROM admin_password_recoveries r')) {
      const valid = this.recovery && this.recovery.reset_token_hash === params[0]
        && params[1] === this.lookupHash && this.recovery.reset_token_expires_at > new Date()
        && this.recovery.verified_at && !this.recovery.consumed_at;
      return { rows: valid ? [{ user_id: this.user.id }] : [], rowCount: valid ? 1 : 0 };
    }
    if (statement.startsWith('UPDATE users SET password_hash')) {
      this.user.password_hash = params[1];
      return { rows: [], rowCount: 1 };
    }
    if (statement.startsWith('DELETE FROM admin_sessions')) {
      this.sessions = this.sessions.filter((userId) => userId !== params[0]);
      return { rows: [], rowCount: 2 };
    }
    if (statement.startsWith('UPDATE admin_password_recoveries SET code_hmac = NULL, reset_token_hash')) {
      this.recovery.code_hmac = null;
      this.recovery.reset_token_hash = null;
      this.recovery.reset_token_expires_at = null;
      this.recovery.consumed_at = new Date();
      return { rows: [], rowCount: 1 };
    }
    if (statement.startsWith('UPDATE admin_password_recoveries SET code_hmac = NULL, consumed_at')) {
      if (this.recovery?.user_id === params[0] && this.recovery.code_hmac === params[1]) {
        this.recovery.code_hmac = null;
        this.recovery.consumed_at = new Date();
      }
      return { rows: [], rowCount: 1 };
    }
    if (statement.startsWith('INSERT INTO audit_log')) return { rows: [], rowCount: 1 };
    throw new Error('Unexpected SQL statement in password-recovery test double.');
  }
}

function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    set(name, value) { this.headers[name] = value; return this; },
    append(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function setup({ sendEmail = async () => {}, hash = hashPassword, logger = console, envOverrides = {} } = {}) {
  const env = makeEnvironment();
  Object.assign(env, envOverrides);
  const pool = new FakeRecoveryPool(env);
  const handlers = createAdminPasswordRecoveryHandlers({ pool, sendEmail, hashPassword: hash, env, logger });
  const request = (body, cookie = '') => ({
    body,
    socket: { remoteAddress: '192.0.2.45' },
    headers: cookie ? { cookie } : {},
  });
  return { env, pool, handlers, request };
}

test('recovery request is generic; a verified code enables one password update and revokes sessions', async () => {
  let delivery;
  const state = setup({ sendEmail: async (recipient, code) => { delivery = { recipient, code }; } });
  const requestResponse = makeResponse();
  await state.handlers.requestCode(state.request({ email: targetEmail }), requestResponse);

  assert.equal(requestResponse.statusCode, 202);
  assert.match(requestResponse.body.message, /Si el correo corresponde/);
  assert.equal(delivery.recipient, targetEmail);
  assert.match(delivery.code, /^\d{6}$/);
  assert.notEqual(state.pool.recovery.code_hmac, delivery.code);

  const verifyResponse = makeResponse();
  await state.handlers.verifyCode(state.request({ email: targetEmail, code: delivery.code }), verifyResponse);
  assert.equal(verifyResponse.statusCode, 200);
  assert.equal(state.pool.recovery.code_hmac, null);
  const grantCookie = verifyResponse.headers['Set-Cookie'].match(/carpinteria_password_reset=([a-f0-9]{64})/)[0];

  const noGrantResponse = makeResponse();
  await state.handlers.completeReset(state.request({ password: 'new-test-password-value', confirmation: 'new-test-password-value' }), noGrantResponse);
  assert.equal(noGrantResponse.statusCode, 400);
  assert.equal(state.pool.user.password_hash, 'previous-hash');

  const newPassword = 'new-test-password-value';
  const resetResponse = makeResponse();
  await state.handlers.completeReset(state.request({ password: newPassword, confirmation: newPassword }, grantCookie), resetResponse);
  assert.equal(resetResponse.statusCode, 200);
  assert.match(state.pool.user.password_hash, /^scrypt\$/);
  assert.equal(await verifyPassword(newPassword, state.pool.user.password_hash), true);
  assert.equal(state.pool.sessions.length, 0);
  assert.ok(state.pool.recovery.consumed_at);

  const reusedCodeResponse = makeResponse();
  await state.handlers.verifyCode(state.request({ email: targetEmail, code: delivery.code }), reusedCodeResponse);
  assert.equal(reusedCodeResponse.statusCode, 400);
});

test('wrong, expired, wrong-account, and exhausted codes cannot authorize a reset', async () => {
  let delivery;
  const state = setup({ sendEmail: async (_recipient, code) => { delivery = code; } });
  await state.handlers.requestCode(state.request({ email: targetEmail }), makeResponse());
  const wrong = delivery === '999999' ? '000000' : '999999';

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = makeResponse();
    await state.handlers.verifyCode(state.request({ email: targetEmail, code: wrong }), response);
    assert.equal(response.statusCode, 400);
  }
  assert.equal(state.pool.recovery.attempt_count, 5);
  assert.equal(state.pool.recovery.code_hmac, null);
  const exhausted = makeResponse();
  await state.handlers.verifyCode(state.request({ email: targetEmail, code: delivery }), exhausted);
  assert.equal(exhausted.statusCode, 400);

  await state.handlers.requestCode(state.request({ email: targetEmail }), makeResponse());
  state.pool.recovery.expires_at = new Date(Date.now() - 1);
  const expired = makeResponse();
  await state.handlers.verifyCode(state.request({ email: targetEmail, code: delivery }), expired);
  assert.equal(expired.statusCode, 400);

  const otherAccount = makeResponse();
  await state.handlers.verifyCode(state.request({ email: 'other@example.invalid', code: delivery }), otherAccount);
  assert.equal(otherAccount.statusCode, 400);
});

test('request limits apply to an account and to repeated requests from one IP', async () => {
  let sends = 0;
  const accountState = setup({ sendEmail: async () => { sends += 1; } });
  const replies = [];
  for (let i = 0; i < 4; i += 1) {
    const response = makeResponse();
    await accountState.handlers.requestCode(accountState.request({ email: targetEmail }), response);
    replies.push(response.body.message);
  }
  assert.equal(sends, 3);
  assert.equal(new Set(replies).size, 1);

  const ipState = setup();
  for (let i = 0; i < 11; i += 1) {
    await ipState.handlers.requestCode(ipState.request({ email: `unknown-${i}@example.invalid` }), makeResponse());
  }
  const ipBucket = [...ipState.pool.rateBuckets.entries()].find(([key]) => key.startsWith('request-ip:'))?.[1];
  assert.equal(ipBucket?.count, 11);
});

test('Render recovery rate bucket ignores spoofed IP headers and applies the per-operation service cap', async () => {
  const state = setup({ envOverrides: { RENDER: 'true', RENDER_SERVICE_TYPE: 'web' } });
  for (let index = 0; index < 11; index += 1) {
    const request = state.request({ email: `unrecognized-${index}@example.invalid` });
    request.headers['cf-connecting-ip'] = `198.51.100.${index + 1}`;
    request.headers['x-forwarded-for'] = `203.0.113.${index + 1}`;
    await state.handlers.requestCode(request, makeResponse());
  }
  const ipBuckets = [...state.pool.rateBuckets.entries()].filter(([key]) => key.startsWith('request-ip:'));
  assert.equal(ipBuckets.length, 1);
  assert.equal(ipBuckets[0][1].count, 11);

  const otherClient = state.request({ email: 'unrecognized-other@example.invalid' });
  otherClient.headers['cf-connecting-ip'] = 'forged,duplicate';
  otherClient.headers['x-forwarded-for'] = '198.51.100.20';
  await state.handlers.requestCode(otherClient, makeResponse());
  const separatedBuckets = [...state.pool.rateBuckets.entries()].filter(([key]) => key.startsWith('request-ip:'));
  assert.equal(separatedBuckets.length, 1);
  assert.equal(separatedBuckets[0][1].count, 12);
});

test('Render recovery uses its stable service bucket when no client IP can be trusted', async () => {
  const state = setup({ envOverrides: { RENDER: 'true', RENDER_SERVICE_TYPE: 'web' } });
  const request = state.request({ email: 'unrecognized@example.invalid' });
  request.headers['x-forwarded-for'] = '198.51.100.20';
  const response = makeResponse();
  await state.handlers.requestCode(request, response);
  assert.equal(response.statusCode, 202);
  const ipBuckets = [...state.pool.rateBuckets.entries()].filter(([key]) => key.startsWith('request-ip:'));
  assert.equal(ipBuckets.length, 1);
  assert.equal(ipBuckets[0][1].count, 1);
});

test('an unknown email receives the same response and SMTP failure does not leave a usable code', async () => {
  const logEntries = [];
  const state = setup({
    sendEmail: async () => { throw new Error('mock SMTP failure'); },
    logger: { error(message) { logEntries.push(message); } },
  });
  const knownResponse = makeResponse();
  await state.handlers.requestCode(state.request({ email: targetEmail }), knownResponse);
  const unknownResponse = makeResponse();
  await state.handlers.requestCode(state.request({ email: 'unknown@example.invalid' }), unknownResponse);
  assert.equal(knownResponse.statusCode, unknownResponse.statusCode);
  assert.deepEqual(knownResponse.body, unknownResponse.body);
  assert.equal(state.pool.recovery.code_hmac, null);
  assert.ok(state.pool.recovery.consumed_at);
  assert.deepEqual(logEntries, ['No se pudo enviar el correo de recuperación.', 'No se pudo enviar el correo de recuperación.']);
  assert.doesNotMatch(logEntries.join(' '), /owner@example|unknown@example|\d{6}|mock SMTP failure/i);
});

test('unknown valid email requests use a bounded decoy delivery without creating a recovery record', async () => {
  const deliveries = [];
  const state = setup({ sendEmail: async (recipient, code) => { deliveries.push({ recipient, code }); } });
  const response = makeResponse();
  await state.handlers.requestCode(state.request({ email: 'unknown@example.invalid' }), response);

  assert.equal(response.statusCode, 202);
  assert.match(response.body.message, /Si el correo corresponde/);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].recipient, state.env.SMTP_USER ?? '');
  assert.match(deliveries[0].code, /^\d{6}$/);
  assert.equal(state.pool.recovery, null);
});

test('the service-wide request limit caps decoy deliveries across distinct IPs', async () => {
  let sends = 0;
  const state = setup({ sendEmail: async () => { sends += 1; } });
  for (let index = 0; index < 21; index += 1) {
    const request = state.request({ email: `unknown-${index}@example.invalid` });
    request.socket.remoteAddress = `192.0.2.${index + 1}`;
    await state.handlers.requestCode(request, makeResponse());
  }
  assert.equal(sends, 20);
});
