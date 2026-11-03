import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { after, before, test } from 'node:test';
import { lookupAdminEmail, getEmailCryptoKeys } from '../server/admin-email-crypto.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'carpinteria-media-routes-'));
const adminEmail = 'media-test@example.invalid';
const encryptionKey = '1'.repeat(64);
const lookupKey = '2'.repeat(64);
const rateLimitKey = '3'.repeat(64);
const csrfToken = '4'.repeat(64);
const sessionToken = '5'.repeat(64);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]);
const mp4 = Buffer.from('0000ftypisom0000', 'ascii');
const remoteKey = `cloudinary:image:${'a'.repeat(64)}`;
const remoteVideoKey = `cloudinary:video:${'b'.repeat(64)}`;
const sessionHash = createHash('sha256').update(sessionToken).digest('hex');
let pool;
let app;
let publicImageHandler;
let publicVideoHandler;
let adminImageHandler;
let adminDeleteHandler;
let uploadImageHandler;
let uploadVideoHandler;
let requireAdminApi;
let requireAdminCsrf;
let encryptedEmail;
let emailLookupHash;
let cloudinarySdk;
let publicMediaVisible = false;
let publicVideoVisible = false;
let publicMediaQueries = 0;
let cloudinaryReadCount = 0;
let failRemoteDelete = false;
let failCommit = false;
const deletionEvents = [];
let transactionQueryHandler;

process.env.MEDIA_STORAGE_PROVIDER = 'cloudinary';
process.env.MEDIA_STORAGE_DIR = directory;
process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud';
process.env.CLOUDINARY_API_KEY = 'test-key';
process.env.CLOUDINARY_API_SECRET = 'test-secret';
process.env.ADMIN_EMAIL = adminEmail;
process.env.EMAIL_ENCRYPTION_KEY = encryptionKey;
process.env.EMAIL_LOOKUP_KEY = lookupKey;
process.env.ADMIN_RATE_LIMIT_KEY = rateLimitKey;
globalThis.fetch = async (url, options = {}) => {
  cloudinaryReadCount += 1;
  const bytes = String(url).includes('/video/') ? mp4 : jpeg;
  const headers = { 'content-length': String(bytes.length) };
  if (options.method === 'HEAD') return new Response(null, { status: 200, headers });
  const range = /^bytes=(\d+)-(\d+)$/.exec(options.headers?.Range ?? '');
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    headers['content-length'] = String(end - start + 1);
    headers['content-range'] = `bytes ${start}-${end}/${bytes.length}`;
    return new Response(bytes.subarray(start, end + 1), { status: 206, headers });
  }
  return new Response(bytes, { status: 200, headers });
};

class MockResponse extends Writable {
  constructor() {
    super();
    this.headers = new Map();
    this.statusCode = 200;
    this.chunks = [];
    this.done = false;
  }
  _write(chunk, _encoding, callback) { this.chunks.push(Buffer.from(chunk)); callback(); }
  set(name, value) {
    if (typeof name === 'object') for (const [key, item] of Object.entries(name)) this.headers.set(key.toLowerCase(), String(item));
    else this.headers.set(name.toLowerCase(), String(value));
    return this;
  }
  setHeader(name, value) { this.headers.set(name.toLowerCase(), String(value)); return this; }
  append(name, value) {
    const key = name.toLowerCase();
    this.headers.set(key, [...(this.headers.has(key) ? [this.headers.get(key)] : []), value].join(', '));
    return this;
  }
  status(code) { this.statusCode = code; return this; }
  json(value) { this.set('content-type', 'application/json'); this.end(JSON.stringify(value)); return this; }
  send(value) { this.end(value); return this; }
  getHeader(name) { return this.headers.get(name.toLowerCase()); }
  get headersSent() { return this.done || this.writable; }
  end(value) { this.done = true; return super.end(value); }
  body() { return Buffer.concat(this.chunks); }
}

before(async () => {
  const crypto = await import('../server/admin-email-crypto.js');
  await import('../server/media-storage.js');
  const db = await import('../server/db.js');
  const appModule = await import('../server/app.js');
  const adminApi = await import('../server/admin-api.js');
  const auth = await import('../server/admin-auth.js');
  cloudinarySdk = (await import('cloudinary')).v2;
  pool = db.pool;
  const emailKeys = crypto.getEmailCryptoKeys();
  encryptedEmail = crypto.encryptAdminEmail(adminEmail, emailKeys);
  emailLookupHash = encryptedEmail.email_lookup_hmac;
  cloudinarySdk.uploader.destroy = async (_publicId, options) => {
    deletionEvents.push('cloudinary-delete');
    if (failRemoteDelete) throw new Error('mock remote delete failure');
    return { result: 'ok', options };
  };
  cloudinarySdk.uploader.upload_stream = (options, callback) => {
    const chunks = [];
    return new Writable({
      write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); },
      final(done) {
        const bytes = Buffer.concat(chunks);
        deletionEvents.push('cloudinary-upload');
        callback(null, {
          public_id: options.public_id,
          resource_type: options.resource_type,
          type: options.type,
          bytes: bytes.length,
        });
        done();
      },
    });
  };
  pool.query = async (sql, values = []) => {
    if (sql.includes('FROM admin_sessions s')) {
      if (values[0] !== sessionHash || values[1] !== emailLookupHash) return { rows: [] };
      return { rows: [{
        session_token_hash: sessionHash,
        csrf_token: csrfToken,
        id: 1,
        name: 'Propietario de prueba',
        ...encryptedEmail,
        role: 'owner',
      }] };
    }
    if (sql.includes('FROM media_assets') && sql.includes('WHERE id = $1')) {
      return { rows: [{ storage_key: remoteKey, mime_type: 'image/jpeg' }] };
    }
    throw new Error('Consulta no prevista en la prueba.');
  };

  const query = async (sql) => {
    if (sql.includes('information_schema.columns')) return { rows: [{ available: 2 }] };
    if (sql.includes('FROM media_assets ma') && sql.includes('classification_status = \'assigned\'')) {
      publicMediaQueries += 1;
      if (sql.includes("ma.media_kind = 'video'")) {
        return { rows: publicVideoVisible ? [{ storage_key: remoteVideoKey, mime_type: 'video/mp4' }] : [] };
      }
      return { rows: publicMediaVisible ? [{ storage_key: remoteKey, mime_type: 'image/jpeg' }] : [] };
    }
    if (sql.includes('FROM products p')) {
      return { rows: [{
        id: 10,
        name: 'Trabajo publicado de prueba',
        slug: 'trabajo-publicado-prueba',
        description: '',
        price: null,
        currency: 'COP',
        measurement_config: [],
        dimensions: {},
        category_name: null,
        category_slug: null,
        media: [],
        video: null,
      }] };
    }
    throw new Error('Consulta pública no prevista en la prueba.');
  };
  transactionQueryHandler = async (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        if (sql === 'ROLLBACK') deletionEvents.push('rollback');
        if (sql === 'COMMIT' && failCommit) throw new Error('mock commit failure');
        return { rows: [] };
      }
      if (sql.includes('SELECT id, media_kind, classification_status, storage_key')) {
        return { rows: [{ id: 17, media_kind: 'image', classification_status: 'pending', storage_key: remoteKey, original_filename: 'test.jpg' }] };
      }
      if (sql.includes('SELECT p.name, p.is_published')) return { rows: [] };
      if (sql.includes('INSERT INTO audit_log')) return { rows: [] };
      if (sql.includes('DELETE FROM media_assets WHERE id')) {
        deletionEvents.push('database-delete');
        return { rows: [] };
      }
      if (sql.includes('SELECT 1 FROM media_assets')) return { rows: [] };
      throw new Error('Consulta transaccional no prevista en la prueba.');
  };
  pool.connect = async () => ({
    query: (sql, values) => transactionQueryHandler(sql, values),
    release() {},
  });
  app = appModule.createApp({ query });
  publicImageHandler = app.router.stack.find((layer) => layer.route?.path === '/media/:id').route.stack[0].handle;
  publicVideoHandler = app.router.stack.find((layer) => layer.route?.path === '/media/video/:id').route.stack[0].handle;
  adminImageHandler = adminApi.default.stack.find((layer) => layer.route?.path === '/media/:id/content').route.stack[0].handle;
  const deleteRoute = adminApi.default.stack.find((layer) => layer.route?.path === '/media/:id' && layer.route.methods.delete);
  adminDeleteHandler = deleteRoute.route.stack[0].handle;
  uploadImageHandler = adminApi.default.stack.find((layer) => layer.route?.path === '/media/upload/:batchId').route.stack.at(-1).handle;
  uploadVideoHandler = adminApi.default.stack.find((layer) => layer.route?.path === '/products/:id/video' && layer.route.methods.put).route.stack.at(-1).handle;
  requireAdminApi = auth.requireAdminApi;
  requireAdminCsrf = auth.requireAdminCsrf;
});

after(async () => {
  if (pool) {
    pool.query = Object.getPrototypeOf(pool).query;
    pool.connect = Object.getPrototypeOf(pool).connect;
    await pool.end().catch(() => {});
  }
  await rm(directory, { recursive: true, force: true });
});

function request(params = {}, headers = {}) {
  return { params, headers, get(name) { return headers[name.toLowerCase()]; } };
}

async function finishAfter(response, operation) {
  const finished = new Promise((resolve, reject) => {
    response.once('finish', resolve);
    response.once('error', reject);
  });
  await operation();
  if (!response.writableFinished) await finished;
}

test('catalog and public media route expose only media returned by publication checks', async () => {
  const securityHeaders = new MockResponse();
  app.router.stack[0].handle({}, securityHeaders, () => {});
  assert.match(securityHeaders.getHeader('content-security-policy'), /img-src 'self' data:/);

  const catalogResponse = new MockResponse();
  await finishAfter(catalogResponse, () => app.router.stack
    .find((layer) => layer.route?.path === '/api/catalog').route.stack[0].handle(request(), catalogResponse));
  assert.equal(catalogResponse.statusCode, 200);
  assert.equal(JSON.parse(catalogResponse.body()).products[0].name, 'Trabajo publicado de prueba');

  const hiddenResponse = new MockResponse();
  await finishAfter(hiddenResponse, () => publicImageHandler(request({ id: '9' }), hiddenResponse));
  assert.equal(hiddenResponse.statusCode, 404);
  assert.equal(publicMediaQueries, 1);

  publicMediaVisible = true;
  const visibleResponse = new MockResponse();
  await finishAfter(visibleResponse, () => publicImageHandler(request({ id: '10' }), visibleResponse));
  assert.equal(visibleResponse.statusCode, 200);
  assert.deepEqual(visibleResponse.body(), jpeg);
  assert.equal(visibleResponse.getHeader('content-type'), 'image/jpeg');

  publicVideoVisible = true;
  const videoResponse = new MockResponse();
  await finishAfter(videoResponse, () => publicVideoHandler(
    request({ id: '11' }, { range: 'bytes=4-7' }), videoResponse,
  ));
  assert.equal(videoResponse.statusCode, 206);
  assert.deepEqual(videoResponse.body(), mp4.subarray(4, 8));
  assert.equal(videoResponse.getHeader('content-range'), `bytes 4-7/${mp4.length}`);
});

test('administrative media content requires the authenticated owner session', async () => {
  const unauthorizedRequest = request({ id: '17' });
  const unauthorizedResponse = new MockResponse();
  await finishAfter(unauthorizedResponse, () => requireAdminApi(unauthorizedRequest, unauthorizedResponse, () => {}));
  assert.equal(unauthorizedResponse.statusCode, 401);

  const authorizedRequest = request({ id: '17' }, { cookie: `carpinteria_admin_session=${sessionToken}` });
  const authorizedResponse = new MockResponse();
  let authorized = false;
  await finishAfter(authorizedResponse, async () => {
    await requireAdminApi(authorizedRequest, authorizedResponse, () => { authorized = true; });
    assert.equal(authorized, true);
    await adminImageHandler(authorizedRequest, authorizedResponse);
  });
  assert.equal(authorizedResponse.statusCode, 200);
  assert.equal(authorizedResponse.getHeader('cache-control'), 'private, no-store');
  assert.equal(authorizedResponse.getHeader('content-type'), 'image/jpeg');
  assert.deepEqual(authorizedResponse.body(), jpeg);
});

test('admin deletion confirms Cloudinary before deleting the PostgreSQL reference', async () => {
  deletionEvents.length = 0;
  const req = request({ id: '17' }, {
    cookie: `carpinteria_admin_session=${sessionToken}`,
    'x-csrf-token': csrfToken,
  });
  req.method = 'DELETE';
  const response = new MockResponse();
  await finishAfter(response, async () => {
    await requireAdminApi(req, response, () => {});
    requireAdminCsrf(req, response, () => {});
    await adminDeleteHandler(req, response);
  });
  assert.equal(response.statusCode, 200);
  assert.ok(deletionEvents.indexOf('cloudinary-delete') >= 0);
  assert.ok(deletionEvents.indexOf('database-delete') > deletionEvents.indexOf('cloudinary-delete'));

  deletionEvents.length = 0;
  failRemoteDelete = true;
  const retryResponse = new MockResponse();
  await finishAfter(retryResponse, async () => {
    await requireAdminApi(req, retryResponse, () => {});
    requireAdminCsrf(req, retryResponse, () => {});
    await adminDeleteHandler(req, retryResponse);
  });
  failRemoteDelete = false;
  assert.equal(retryResponse.statusCode, 503);
  assert.ok(!deletionEvents.includes('database-delete'));
  assert.ok(deletionEvents.includes('rollback'));
  assert.ok(deletionEvents.includes('cloudinary-upload'), 'an uncertain remote delete is compensated from its backup');

  deletionEvents.length = 0;
  failRemoteDelete = false;
  failCommit = true;
  const commitFailureResponse = new MockResponse();
  await finishAfter(commitFailureResponse, async () => {
    await requireAdminApi(req, commitFailureResponse, () => {});
    requireAdminCsrf(req, commitFailureResponse, () => {});
    await adminDeleteHandler(req, commitFailureResponse);
  });
  failCommit = false;
  assert.equal(commitFailureResponse.statusCode, 503);
  assert.ok(deletionEvents.indexOf('cloudinary-upload') > deletionEvents.indexOf('rollback'));
});

test('administrative image and video upload routes validate and persist Cloudinary references', async () => {
  const insertedStorageKeys = [];
  transactionQueryHandler = async (sql, values = []) => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('count(*)::integer AS total FROM media_assets')) return { rows: [{ total: 0 }] };
    if (sql.includes('FROM media_assets') && sql.includes('upload_batch_id = $1')) return { rows: [] };
    if (sql.includes('SELECT id FROM products WHERE id = $1 FOR UPDATE')) return { rows: [{ id: 10 }] };
    if (sql.includes('SELECT ma.id, ma.storage_key')) return { rows: [] };
    if (sql.includes('INSERT INTO media_assets')) {
      insertedStorageKeys.push(values[0]);
      if (sql.includes("VALUES ($1, 'image'")) {
        return { rows: [{ id: 21, original_filename: values[2], mime_type: values[1], byte_size: values[4], created_at: new Date().toISOString() }] };
      }
      return { rows: [{ id: 22 }] };
    }
    if (sql.includes('INSERT INTO product_media')) return { rows: [] };
    if (sql.includes('INSERT INTO audit_log')) return { rows: [] };
    throw new Error('Consulta de carga no prevista en la prueba.');
  };

  const imageRequest = request({ batchId: 'a2222222-2222-4222-8222-222222222222' }, {
    cookie: `carpinteria_admin_session=${sessionToken}`,
    'x-csrf-token': csrfToken,
    'x-original-filename': 'imagen.jpg',
  });
  imageRequest.method = 'POST';
  imageRequest.body = jpeg;
  const imageResponse = new MockResponse();
  await finishAfter(imageResponse, async () => {
    await requireAdminApi(imageRequest, imageResponse, () => {});
    requireAdminCsrf(imageRequest, imageResponse, () => {});
    await uploadImageHandler(imageRequest, imageResponse);
  });
  assert.equal(imageResponse.statusCode, 201);
  assert.match(insertedStorageKeys[0], /^cloudinary:image:[a-f0-9]{64}$/);
  assert.equal(JSON.parse(imageResponse.body()).media.adminUrl, '/api/admin/media/21/content');

  const videoRequest = request({ id: '10' }, {
    cookie: `carpinteria_admin_session=${sessionToken}`,
    'x-csrf-token': csrfToken,
    'x-original-filename': 'video.mp4',
  });
  videoRequest.method = 'PUT';
  videoRequest.body = mp4;
  const videoResponse = new MockResponse();
  await finishAfter(videoResponse, async () => {
    await requireAdminApi(videoRequest, videoResponse, () => {});
    requireAdminCsrf(videoRequest, videoResponse, () => {});
    await uploadVideoHandler(videoRequest, videoResponse);
  });
  assert.equal(videoResponse.statusCode, 201);
  assert.match(insertedStorageKeys[1], /^cloudinary:video:[a-f0-9]{64}$/);
  assert.equal(JSON.parse(videoResponse.body()).video.url, '/media/video/22');
});

test('admin session fixture uses the project HMAC and encrypted email fields', () => {
  const expected = lookupAdminEmail(adminEmail, getEmailCryptoKeys().lookupKey);
  assert.equal(emailLookupHash, expected);
  assert.equal(typeof encryptedEmail.email_ciphertext, 'string');
  assert.ok(!JSON.stringify(encryptedEmail).includes(adminEmail));
});
