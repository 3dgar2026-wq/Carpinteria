import assert from 'node:assert/strict';
import test from 'node:test';
import { createMediaStorage } from '../server/media-storage.js';
import { validateMediaStorageConfiguration } from '../server/media-storage-config.js';

const validProductionEnv = {
  NODE_ENV: 'production',
  MEDIA_STORAGE_PROVIDER: 'cloudinary',
  CLOUDINARY_CLOUD_NAME: 'carpinteria-test',
  CLOUDINARY_API_KEY: '1234567890',
  CLOUDINARY_API_SECRET: 'placeholder-secret-for-unit-test',
};

test('production configuration requires the exact Cloudinary provider', () => {
  assert.throws(() => validateMediaStorageConfiguration({ NODE_ENV: 'production' }), /MEDIA_STORAGE_PROVIDER=cloudinary/);
  assert.throws(() => validateMediaStorageConfiguration({ ...validProductionEnv, MEDIA_STORAGE_PROVIDER: 'local' }), /MEDIA_STORAGE_PROVIDER=cloudinary/);
  assert.throws(() => validateMediaStorageConfiguration({ ...validProductionEnv, MEDIA_STORAGE_PROVIDER: 'Cloudinary' }), /MEDIA_STORAGE_PROVIDER=cloudinary/);
});

test('production configuration rejects missing, whitespace-padded, or malformed Cloudinary settings by name only', () => {
  for (const name of ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']) {
    const env = { ...validProductionEnv };
    delete env[name];
    assert.throws(() => validateMediaStorageConfiguration(env), new RegExp(name));
  }
  assert.throws(() => validateMediaStorageConfiguration({ ...validProductionEnv, CLOUDINARY_API_SECRET: ' secret ' }), /CLOUDINARY_API_SECRET/);
  assert.equal(validateMediaStorageConfiguration(validProductionEnv), 'cloudinary');
});

test('configured production storage uses Cloudinary and refuses legacy local keys', async () => {
  const client = {
    config(settings) { this.settings = settings; },
    url() { return 'https://cloudinary.invalid/private-resource'; },
    uploader: { upload_stream() {}, destroy: async () => ({ result: 'ok' }) },
  };
  const storage = createMediaStorage({
    env: validProductionEnv,
    cloudinaryClient: client,
    fetchImpl: async () => new Response(null, { status: 404 }),
  });
  assert.equal(storage.provider, 'cloudinary');
  assert.deepEqual(client.settings, {
    cloud_name: validProductionEnv.CLOUDINARY_CLOUD_NAME,
    api_key: validProductionEnv.CLOUDINARY_API_KEY,
    api_secret: validProductionEnv.CLOUDINARY_API_SECRET,
    secure: true,
  });
  await assert.rejects(storage.openStoredImage('123e4567-e89b-42d3-a456-426614174000.jpg'), {
    code: 'LOCAL_MEDIA_DISABLED_IN_PRODUCTION',
  });
  await assert.rejects(storage.removeStoredImage('123e4567-e89b-42d3-a456-426614174000.jpg'), {
    code: 'LOCAL_MEDIA_DISABLED_IN_PRODUCTION',
  });
});

test('local storage remains the development default but is rejected in production', () => {
  assert.equal(validateMediaStorageConfiguration({ NODE_ENV: 'development' }), 'local');
  assert.throws(() => createMediaStorage({ env: { NODE_ENV: 'production', MEDIA_STORAGE_PROVIDER: 'local' } }), /MEDIA_STORAGE_PROVIDER=cloudinary/);
});
