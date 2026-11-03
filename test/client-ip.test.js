import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeClientIp, resolveClientIp } from '../server/client-ip.js';

function request({ socketIp = '127.0.0.1', headers = {} } = {}) {
  return { socket: { remoteAddress: socketIp }, headers };
}

test('direct development requests use the socket and ignore forwarded headers', () => {
  const req = request({
    socketIp: '198.51.100.8',
    headers: { 'x-forwarded-for': '203.0.113.200', 'cf-connecting-ip': '203.0.113.201' },
  });
  assert.equal(resolveClientIp(req, {}), '198.51.100.8');
});

test('Render requests do not trust forwarded IP headers because public and private traffic share the listener', () => {
  const env = { RENDER: 'true', RENDER_SERVICE_TYPE: 'web' };
  const publicRequest = request({ socketIp: '10.0.0.2', headers: { 'cf-connecting-ip': '198.51.100.8', 'x-forwarded-for': '203.0.113.1' } });
  const privateRequest = request({ socketIp: '10.0.0.9', headers: { 'cf-connecting-ip': '192.0.2.99', 'x-forwarded-for': '198.51.100.8' } });
  assert.equal(resolveClientIp(publicRequest, env), null);
  assert.equal(resolveClientIp(privateRequest, env), null);
});

test('Render ignores missing, invalid, duplicated, and manipulated forwarding headers', () => {
  const env = { RENDER: 'true', RENDER_SERVICE_TYPE: 'web' };
  for (const headers of [
    {},
    { 'cf-connecting-ip': 'not-an-ip' },
    { 'cf-connecting-ip': '198.51.100.1, 198.51.100.2' },
    { 'cf-connecting-ip': '198.51.100.1', 'x-forwarded-for': '198.51.100.2' },
  ]) assert.equal(resolveClientIp(request({ socketIp: '10.0.0.4', headers }), env), null);
  assert.equal(resolveClientIp(request({ headers: { 'cf-connecting-ip': '198.51.100.2' } }), { RENDER: 'true', RENDER_SERVICE_TYPE: 'worker' }), null);
});

test('IPv4 and IPv6 are accepted and canonicalized for stable buckets', () => {
  assert.equal(normalizeClientIp('192.0.2.9'), '192.0.2.9');
  assert.equal(normalizeClientIp('::ffff:192.0.2.9'), '192.0.2.9');
  assert.equal(normalizeClientIp('2001:0DB8:0:0:0:0:0:1'), '2001:db8::1');
  assert.equal(normalizeClientIp('2001:db8::1'), '2001:db8::1');
  assert.equal(resolveClientIp(request({ socketIp: '2001:db8::2' }), {}), '2001:db8::2');
});
