import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { after, test } from 'node:test';
import { createMediaStorage, validateImageBuffer, validateVideoBuffer } from '../server/media-storage.js';
import { checkCloudinaryEnvironment, cloudinarySdkConfigMatches, safeCloudinaryError } from '../server/cloudinary-diagnostics.js';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]);
const mp4 = Buffer.from('0000ftypisom0000', 'ascii');
const temporaryDirectories = [];

async function makeTemporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'carpinteria-media-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

function mockCloudinary({ failUpload = false, failDelete = false } = {}) {
  const resources = new Map();
  const optionsSeen = [];
  const deletions = [];
  const client = {
    config(config) { this.configuration = config; },
    url(publicId, options) {
      return `https://cloudinary.invalid/${options.resource_type}/${options.type}/${publicId}`;
    },
    uploader: {
      upload_stream(options, callback) {
        optionsSeen.push(options);
        const chunks = [];
        return new Writable({
          write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); },
          final(done) {
            if (failUpload) {
              const error = new Error('mock upload failure');
              error.code = 'MOCK_UPLOAD_FAILURE';
              callback(error);
              done();
              return;
            }
            const bytes = Buffer.concat(chunks);
            const prior = resources.get(options.public_id);
            if (prior) {
              const error = new Error('already exists');
              error.http_code = 409;
              callback(error);
            } else {
              resources.set(options.public_id, { bytes, options });
              callback(null, {
                public_id: options.public_id,
                resource_type: options.resource_type,
                type: options.type,
                bytes: bytes.length,
              });
            }
            done();
          },
        });
      },
      async destroy(publicId, options) {
        deletions.push({ publicId, options });
        if (failDelete) throw new Error('mock delete failure');
        return { result: resources.delete(publicId) ? 'ok' : 'not found' };
      },
    },
  };
  return { client, resources, optionsSeen, deletions };
}

function cloudinaryStorage(mock) {
  return async (url, options = {}) => {
  const [, kind, , ...publicIdParts] = new URL(url).pathname.split('/');
  const publicId = publicIdParts.join('/');
  const item = mock.resources.get(publicId);
  if (!item) return new Response(null, { status: 404 });
  const { bytes } = item;
  const headers = { 'content-length': String(bytes.length) };
  if (options.method === 'HEAD') return new Response(null, { status: 200, headers });
  const rangeHeader = options.headers?.Range;
  if (rangeHeader) {
    const range = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader);
    assert.ok(range);
    const start = Number(range[1]);
    const end = Number(range[2]);
    headers['content-range'] = `bytes ${start}-${end}/${bytes.length}`;
    headers['content-length'] = String(end - start + 1);
    return new Response(bytes.subarray(start, end + 1), { status: 206, headers });
  }
  assert.ok(['image', 'video'].includes(kind));
    return new Response(bytes, { status: 200, headers });
  };
}

test('Cloudinary uploads use authenticated, unique resources and support image/video reads and deletes', async () => {
  const mock = mockCloudinary();
  const storage = createMediaStorage({
    env: {
      MEDIA_STORAGE_PROVIDER: 'cloudinary',
      CLOUDINARY_CLOUD_NAME: 'test-cloud',
      CLOUDINARY_API_KEY: 'test-key',
      CLOUDINARY_API_SECRET: 'test-secret',
    },
    cloudinaryClient: mock.client,
    fetchImpl: cloudinaryStorage(mock),
  });

  const imageFormat = validateImageBuffer(jpeg);
  const videoFormat = validateVideoBuffer(mp4);
  assert.ok(imageFormat);
  assert.ok(videoFormat);
  const imageKey = await storage.storeImage(jpeg, imageFormat, { idempotencyKey: 'a'.repeat(64) });
  const videoKey = await storage.storeVideo(mp4, videoFormat, { idempotencyKey: 'b'.repeat(64) });
  const independentVideoKey = await storage.storeVideo(mp4, videoFormat);

  assert.match(imageKey, /^cloudinary:image:[a-f0-9]{64}$/);
  assert.match(videoKey, /^cloudinary:video:[a-f0-9]{64}$/);
  assert.equal(mock.optionsSeen.length, 3);
  assert.notEqual(independentVideoKey, videoKey, 'a separate video upload receives a fresh non-overwriting ID');
  assert.ok(mock.optionsSeen.every((options) => options.type === 'authenticated' && options.overwrite === false));
  assert.equal(mock.optionsSeen[0].resource_type, 'image');
  assert.equal(mock.optionsSeen[1].resource_type, 'video');
  assert.equal(mock.client.configuration.secure, true);
  assert.equal(mock.client.configuration.cloud_name, 'test-cloud');
  assert.equal(mock.client.configuration.api_key, 'test-key');
  assert.equal(mock.client.configuration.api_secret, 'test-secret');
  assert.equal(cloudinarySdkConfigMatches(mock.client.configuration, {
    CLOUDINARY_CLOUD_NAME: 'test-cloud',
    CLOUDINARY_API_KEY: 'test-key',
    CLOUDINARY_API_SECRET: 'test-secret',
  }), true);
  assert.equal(await storage.storeImage(jpeg, imageFormat, { idempotencyKey: 'a'.repeat(64) }), imageKey,
    'a retry reuses the same verified remote resource');
  assert.equal(await storage.storedImageMatches(imageKey, jpeg), true);
  assert.equal(await storage.getStoredVideoSize(videoKey), mp4.length);
  const { stream } = await storage.openStoredVideo(videoKey, { start: 4, end: 7 });
  const rangedChunks = [];
  for await (const chunk of stream) rangedChunks.push(chunk);
  assert.deepEqual(Buffer.concat(rangedChunks), mp4.subarray(4, 8));

  await storage.removeStoredImage(imageKey);
  await storage.removeStoredVideo(videoKey);
  await storage.removeStoredVideo(independentVideoKey);
  assert.equal(mock.resources.size, 0);
  assert.ok(mock.deletions.every(({ options }) => options.type === 'authenticated' && options.invalidate === true));
});

test('Cloudinary diagnostics validate configuration and redact nested API error details', () => {
  const env = {
    CLOUDINARY_CLOUD_NAME: 'carpinteria-prod',
    CLOUDINARY_API_KEY: '1234567890',
    CLOUDINARY_API_SECRET: 'a-secret-value-that-must-not-appear',
  };
  const checks = checkCloudinaryEnvironment(env);
  assert.ok(Object.values(checks).every((item) => item.present && item.formatValid));
  const invalid = checkCloudinaryEnvironment({ ...env, CLOUDINARY_CLOUD_NAME: 'bad name' });
  assert.equal(invalid.CLOUDINARY_CLOUD_NAME.present, true);
  assert.equal(invalid.CLOUDINARY_CLOUD_NAME.formatValid, false);

  const diagnostic = safeCloudinaryError({
    request_options: { headers: { Authorization: 'secret header' } },
    query_params: { api_secret: env.CLOUDINARY_API_SECRET },
    error: {
      http_code: 401,
      code: 'AUTHENTICATION_FAILED',
      message: `Unauthorized for ${env.CLOUDINARY_CLOUD_NAME}; api_secret=${env.CLOUDINARY_API_SECRET}; https://api.invalid/path?token=hidden`,
    },
  }, env);
  assert.equal(diagnostic.httpStatus, 401);
  assert.equal(diagnostic.code, 'AUTHENTICATION_FAILED');
  assert.ok(diagnostic.message.includes('Unauthorized'));
  assert.ok(diagnostic.message.includes('[URL omitida]'));
  assert.ok(!diagnostic.message.includes(env.CLOUDINARY_CLOUD_NAME));
  assert.ok(!diagnostic.message.includes(env.CLOUDINARY_API_SECRET));
  assert.ok(!diagnostic.message.includes('hidden'));
  assert.ok(!JSON.stringify(diagnostic).includes('secret header'));

  const notFound = safeCloudinaryError({ error: { http_code: 404, message: 'Resource not found.' } }, env);
  assert.equal(notFound.httpStatus, 404);
  assert.equal(notFound.code, 'HTTP_404');
});

test('Cloudinary upload failures do not create a storage reference and failed deletes are surfaced', async () => {
  const uploadMock = mockCloudinary({ failUpload: true });
  const uploadStorage = createMediaStorage({
    env: { MEDIA_STORAGE_PROVIDER: 'cloudinary', CLOUDINARY_CLOUD_NAME: 'x', CLOUDINARY_API_KEY: 'y', CLOUDINARY_API_SECRET: 'z' },
    cloudinaryClient: uploadMock.client,
    fetchImpl: cloudinaryStorage(uploadMock),
  });
  await assert.rejects(
    uploadStorage.storeImage(jpeg, validateImageBuffer(jpeg), { idempotencyKey: 'c'.repeat(64) }),
    (error) => error.code === 'MOCK_UPLOAD_FAILURE',
  );

  const deleteMock = mockCloudinary({ failDelete: true });
  const deleteStorage = createMediaStorage({
    env: { MEDIA_STORAGE_PROVIDER: 'cloudinary', CLOUDINARY_CLOUD_NAME: 'x', CLOUDINARY_API_KEY: 'y', CLOUDINARY_API_SECRET: 'z' },
    cloudinaryClient: deleteMock.client,
    fetchImpl: cloudinaryStorage(deleteMock),
  });
  await assert.rejects(deleteStorage.removeStoredImage(`cloudinary:image:${'d'.repeat(64)}`),
    (error) => error.code === 'CLOUDINARY_DELETE_FAILED');
});

test('Cloudinary read communication failures surface as unavailable media errors', async () => {
  const mock = mockCloudinary();
  const storage = createMediaStorage({
    env: { MEDIA_STORAGE_PROVIDER: 'cloudinary', CLOUDINARY_CLOUD_NAME: 'x', CLOUDINARY_API_KEY: 'y', CLOUDINARY_API_SECRET: 'z' },
    cloudinaryClient: mock.client,
    fetchImpl: async () => { throw new Error('network unavailable'); },
  });
  await assert.rejects(storage.openStoredImage(`cloudinary:image:${'e'.repeat(64)}`),
    (error) => error.code === 'CLOUDINARY_NETWORK_ERROR');
});

test('local storage remains compatible with legacy filenames and keeps files readable', async () => {
  const directory = await makeTemporaryDirectory();
  const storage = createMediaStorage({ env: { MEDIA_STORAGE_PROVIDER: 'local', MEDIA_STORAGE_DIR: directory } });
  const key = await storage.storeImage(jpeg, validateImageBuffer(jpeg));
  assert.match(key, /^[0-9a-f-]{36}\.jpg$/);
  const stream = await storage.openStoredImage(key);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), jpeg);
  assert.deepEqual(await readFile(path.join(directory, key)), jpeg);
  await storage.removeStoredImage(key);
  await assert.rejects(readFile(path.join(directory, key)), { code: 'ENOENT' });
});
