import pg from 'pg';
import {
  createMediaStorage,
  isCloudinaryStorageKey,
  makeMediaIdempotencyKey,
  validateImageBuffer,
  validateVideoBuffer,
} from '../server/media-storage.js';

const { Client } = pg;
const args = process.argv.slice(2);
const expectedDatabase = args[1];
const apply = args.includes('--apply');
const allowedArgs = args.length === 2 || (args.length === 3 && args[2] === '--apply');
const connectionString = process.env.DATABASE_URL_UNPOOLED;
const localStore = createMediaStorage({ env: { ...process.env, MEDIA_STORAGE_PROVIDER: 'local' } });
const cloudinaryStore = createMediaStorage({ env: { ...process.env, MEDIA_STORAGE_PROVIDER: 'cloudinary' } });
const maximumImageBytes = cloudinaryStore.maxMediaFileBytes;
const maximumVideoBytes = cloudinaryStore.maxVideoFileBytes;

function printSafe(message) {
  process.stdout.write(`${message}\n`);
}

function safeCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code)
    ? error.code
    : 'MEDIA_MIGRATION_FAILED';
}

async function collectStream(stream, maximumBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maximumBytes) {
      stream.destroy?.();
      const error = new Error('Local media exceeds configured limit');
      error.code = 'LOCAL_MEDIA_TOO_LARGE';
      throw error;
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

async function readLocalAsset(row) {
  if (isCloudinaryStorageKey(row.storage_key)) return { status: 'already_remote' };
  const kind = row.media_kind;
  const maxBytes = kind === 'image' ? maximumImageBytes : maximumVideoBytes;
  const stream = kind === 'image'
    ? await localStore.openStoredImage(row.storage_key)
    : (await localStore.openStoredVideo(row.storage_key)).stream;
  const bytes = await collectStream(stream, maxBytes);
  const format = kind === 'image' ? validateImageBuffer(bytes) : validateVideoBuffer(bytes);
  if (!format || format.mimeType !== row.mime_type) return { status: 'invalid' };
  if (row.byte_size !== null && Number(row.byte_size) !== bytes.length) return { status: 'size_mismatch' };
  return { status: 'valid', bytes, format };
}

async function migrateOne(client, row) {
  let local;
  try { local = await readLocalAsset(row); }
  catch (error) { return { status: 'failed', code: safeCode(error) }; }
  if (local.status !== 'valid') return { status: local.status };
  if (!apply) return { status: 'ready' };

  const idempotencyKey = makeMediaIdempotencyKey('media-migration-v1', String(row.id), row.storage_key, local.bytes);
  let remoteKey;
  try {
    const options = { idempotencyKey };
    remoteKey = row.media_kind === 'image'
      ? await cloudinaryStore.storeImage(local.bytes, local.format, options)
      : await cloudinaryStore.storeVideo(local.bytes, local.format, options);
    const matches = row.media_kind === 'image'
      ? await cloudinaryStore.storedImageMatches(remoteKey, local.bytes)
      : await cloudinaryStore.storedVideoMatches(remoteKey, local.bytes);
    if (!matches) return { status: 'failed', code: 'CLOUDINARY_VERIFY_FAILED' };
  } catch (error) {
    return { status: 'failed', code: safeCode(error) };
  }

  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT storage_key FROM public.media_assets WHERE id = $1 FOR UPDATE',
      [row.id],
    );
    if (!rows.length || rows[0].storage_key !== row.storage_key) {
      await client.query('ROLLBACK');
      return { status: 'changed_during_migration' };
    }
    await client.query(
      'UPDATE public.media_assets SET storage_key = $2 WHERE id = $1 AND storage_key = $3',
      [row.id, remoteKey, row.storage_key],
    );
    await client.query('COMMIT');
    return { status: 'migrated' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    return { status: 'retryable', code: safeCode(error) };
  }
}

if (!allowedArgs || args[0] !== '--database' || !/^[a-z_][a-z0-9_]{0,62}$/i.test(expectedDatabase ?? '')) {
  console.error('Uso: npm run db:migrate-media-to-cloudinary -- --database <nombre-exacto> [--apply]');
  process.exit(1);
}
if (!connectionString) {
  console.error('Falta DATABASE_URL_UNPOOLED. No se realizó ninguna operación.');
  process.exit(1);
}
try {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || /-pooler\./i.test(url.hostname)) {
    throw new Error('Direct connection required');
  }
} catch {
  console.error('DATABASE_URL_UNPOOLED debe ser una URL PostgreSQL directa válida. No se realizó ninguna operación.');
  process.exit(1);
}

const client = new Client({ connectionString, connectionTimeoutMillis: 15000 });
const counts = { discovered: 0, ready: 0, migrated: 0, alreadyRemote: 0, invalid: 0, sizeMismatch: 0, changedDuringMigration: 0, retryable: 0, failed: 0 };
try {
  await client.connect();
  const { rows: identity } = await client.query('SELECT current_database() AS name, current_schema() AS schema_name');
  if (identity[0]?.name !== expectedDatabase || identity[0]?.schema_name !== 'public') {
    throw Object.assign(new Error('Unexpected database or schema'), { code: 'DATABASE_OR_SCHEMA_MISMATCH' });
  }
  const { rows } = await client.query(`
    SELECT id, storage_key, media_kind, mime_type, byte_size
    FROM public.media_assets
    ORDER BY id
  `);
  counts.discovered = rows.length;
  for (const row of rows) {
    const result = await migrateOne(client, row);
    if (result.status === 'ready') counts.ready += 1;
    else if (result.status === 'migrated') counts.migrated += 1;
    else if (result.status === 'already_remote') counts.alreadyRemote += 1;
    else if (result.status === 'invalid') counts.invalid += 1;
    else if (result.status === 'size_mismatch') counts.sizeMismatch += 1;
    else if (result.status === 'changed_during_migration') counts.changedDuringMigration += 1;
    else if (result.status === 'retryable') counts.retryable += 1;
    else counts.failed += 1;
    if (result.code) console.error(`La migración de un archivo falló con código ${result.code}.`);
  }
  printSafe(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...counts, localFilesPreserved: true }));
} catch (error) {
  console.error(`No se completó la migración multimedia. código=${safeCode(error)}.`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
