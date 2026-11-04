import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const [initialSchema, adminApi, catalog, app] = await Promise.all([
  readFile(new URL('../db/migrations/001_initial_schema.sql', import.meta.url), 'utf8'),
  readFile(new URL('../server/admin-api.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/catalog.js', import.meta.url), 'utf8'),
  readFile(new URL('../server/app.js', import.meta.url), 'utf8'),
]);

test('product names can repeat while product IDs and slugs remain independent', () => {
  const productTable = initialSchema.match(/CREATE TABLE products \(([\s\S]*?)\n\);/)?.[1];
  assert.ok(productTable, 'products table exists');
  assert.match(productTable, /id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY/);
  assert.match(productTable, /name TEXT NOT NULL,/);
  assert.doesNotMatch(productTable, /name TEXT NOT NULL UNIQUE/);
  assert.match(productTable, /slug TEXT NOT NULL UNIQUE/);
  assert.match(adminApi, /async function uniqueProductSlug[\s\S]*?suffix/);
});

test('media schema attaches independent image and video assets to products', () => {
  assert.match(initialSchema, /media_kind TEXT NOT NULL CHECK \(media_kind IN \('image', 'video'\)\)/);
  assert.match(initialSchema, /product_id BIGINT NOT NULL REFERENCES products\(id\) ON DELETE CASCADE/);
  assert.match(initialSchema, /PRIMARY KEY \(product_id, media_asset_id\)/);
  assert.match(app, /pm\.product_id = p\.id[\s\S]*?media_kind = 'image'/);
  assert.match(app, /pm\.product_id = p\.id[\s\S]*?media_kind = 'video'/);
});

test('WhatsApp summary includes every selected public photo and video as separate links', () => {
  assert.match(catalog, /photos\.forEach\(\(photo, photoIndex\)/);
  assert.match(catalog, /publicVideos\.forEach\(\(video, videoIndex\)/);
  assert.match(catalog, /new URL\(video\.url, window\.location\.origin\)\.href/);
  assert.match(catalog, /window\.location\.assign\(`https:\/\/wa\.me\/\$\{destination\}\?text=\$\{encodeURIComponent\(message\)\}`\)/);
});
