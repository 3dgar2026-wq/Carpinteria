import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import test from 'node:test';
import { createLoginAttemptLimiter, getLoginRateBucket } from '../server/admin-auth.js';

class FakeLoginPool {
  constructor(now) {
    this.now = now;
    this.buckets = new Map();
  }

  async connect() {
    return {
      query: (sql, params = []) => this.query(sql, params),
      release() {},
    };
  }

  async query(sql, params = []) {
    const statement = sql.replace(/\s+/g, ' ').trim();
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(statement)) return { rows: [], rowCount: 0 };
    if (statement.startsWith('DELETE FROM admin_login_attempts')) return { rows: [], rowCount: 0 };
    if (statement.startsWith('INSERT INTO admin_login_attempts')) {
      if (!this.buckets.has(params[0])) {
        this.buckets.set(params[0], { attempt_count: 0, window_started_at: new Date(this.now), blocked_until: null });
      }
      return { rows: [], rowCount: 1 };
    }
    if (statement.startsWith('SELECT attempt_count')) {
      return { rows: [this.buckets.get(params[0])], rowCount: 1 };
    }
    if (statement.includes('SET attempt_count = 1')) {
      Object.assign(this.buckets.get(params[0]), { attempt_count: 1, window_started_at: new Date(this.now), blocked_until: null });
      return { rows: [], rowCount: 1 };
    }
    if (statement.includes('SET blocked_until =')) {
      const bucket = this.buckets.get(params[0]);
      bucket.blocked_until = new Date(new Date(bucket.window_started_at).getTime() + 15 * 60 * 1000);
      return { rows: [], rowCount: 1 };
    }
    if (statement.includes('SET attempt_count = attempt_count + 1')) {
      this.buckets.get(params[0]).attempt_count += 1;
      return { rows: [], rowCount: 1 };
    }
    throw new Error('Unexpected SQL in login limiter test double.');
  }
}

test('Render login bucket uses the configured owner identity and ignores every client-supplied IP header', () => {
  const env = { RENDER: 'true', RENDER_SERVICE_TYPE: 'web' };
  const key = randomBytes(32);
  const ownerHash = randomBytes(32).toString('hex');
  const makeRequest = (clientIp, forwardedFor) => ({
    socket: { remoteAddress: '10.0.0.2' },
    headers: { 'cf-connecting-ip': clientIp, 'x-forwarded-for': forwardedFor },
  });
  const first = getLoginRateBucket(makeRequest('198.51.100.1', '203.0.113.10'), { key, env, accountHash: ownerHash });
  const manipulated = getLoginRateBucket(makeRequest('192.0.2.77, 203.0.113.9', '198.51.100.1'), { key, env, accountHash: ownerHash });

  assert.equal(first, createHmac('sha256', key).update(`login-owner:${ownerHash}`).digest('hex'));
  assert.equal(first, manipulated);
  assert.equal(getLoginRateBucket(makeRequest('198.51.100.1', '198.51.100.1'), { key, env }), null);
});

test('direct development login buckets distinguish normalized IPv4 and IPv6 addresses', () => {
  const key = randomBytes(32);
  const env = {};
  const makeRequest = (remoteAddress) => ({ socket: { remoteAddress }, headers: { 'x-forwarded-for': '203.0.113.1' } });
  const ipv4 = getLoginRateBucket(makeRequest('198.51.100.1'), { key, env });
  const ipv6 = getLoginRateBucket(makeRequest('2001:db8::1'), { key, env });
  assert.notEqual(ipv4, ipv6);
  assert.equal(getLoginRateBucket(makeRequest('2001:0db8:0:0:0:0:0:1'), { key, env }), ipv6);
});

test('login limiter preserves five attempts per client and separates distinct client IPs', async () => {
  const now = Date.now();
  const fakePool = new FakeLoginPool(now);
  const allowAttempt = createLoginAttemptLimiter({ limiterPool: fakePool, now: () => now });
  for (let attempt = 0; attempt < 5; attempt += 1) assert.equal(await allowAttempt('client-a'), true);
  assert.equal(await allowAttempt('client-a'), false);
  assert.equal(await allowAttempt('client-b'), true);
  assert.equal(fakePool.buckets.get('client-a').attempt_count, 5);
  assert.equal(fakePool.buckets.get('client-b').attempt_count, 1);
});
