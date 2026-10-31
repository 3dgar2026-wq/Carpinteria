import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(projectRoot, 'public');
const allowedFormats = [
  { extension: 'jpg', mimeType: 'image/jpeg', matches: (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  { extension: 'png', mimeType: 'image/png', matches: (bytes) => bytes.length >= 24
    && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    && bytes.toString('ascii', 12, 16) === 'IHDR'
    && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0 },
  { extension: 'webp', mimeType: 'image/webp', matches: (bytes) => bytes.length >= 12
    && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' },
];
const allowedVideoFormats = [
  { extension: 'mp4', mimeType: 'video/mp4', matches: (bytes) => bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp' },
  { extension: 'webm', mimeType: 'video/webm', matches: (bytes) => bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) },
];

function configuredInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`La configuración ${name} debe ser un entero.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`La configuración ${name} está fuera del rango permitido.`);
  }
  return value;
}

export const maxMediaFileBytes = configuredInteger('MEDIA_MAX_FILE_BYTES', 5 * 1024 * 1024, 1024, 20 * 1024 * 1024);
export const maxMediaBatchFiles = configuredInteger('MEDIA_MAX_BATCH_FILES', 100, 1, 100);
export const maxVideoFileBytes = configuredInteger('MEDIA_MAX_VIDEO_FILE_BYTES', 50 * 1024 * 1024, 1024, 100 * 1024 * 1024);

export function validateImageBuffer(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return null;
  return allowedFormats.find((format) => format.matches(bytes)) ?? null;
}

export function validateVideoBuffer(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return null;
  return allowedVideoFormats.find((format) => format.matches(bytes)) ?? null;
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function storageRoot() {
  const configuredRoot = path.resolve(process.env.MEDIA_STORAGE_DIR || path.join(projectRoot, 'var', 'media'));
  if (isWithin(publicRoot, configuredRoot)) {
    throw new Error('El almacenamiento multimedia debe estar fuera de public.');
  }
  await mkdir(configuredRoot, { recursive: true });
  const [root, actualPublicRoot] = await Promise.all([realpath(configuredRoot), realpath(publicRoot)]);
  if (isWithin(actualPublicRoot, root)) {
    throw new Error('El almacenamiento multimedia debe estar fuera de public.');
  }
  return root;
}

function safeStorageFilename(storageKey, includeVideo = false) {
  const extensionPattern = includeVideo ? '(?:jpg|png|webp|mp4|webm)' : '(?:jpg|png|webp)';
  if (typeof storageKey !== 'string' || !new RegExp(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.${extensionPattern}$`).test(storageKey)) {
    throw new Error('La referencia del archivo no es válida.');
  }
  return storageKey;
}

export async function storeImage(bytes, format) {
  if (!format || !allowedFormats.includes(format)) throw new Error('El formato de la imagen no es válido.');
  const root = await storageRoot();
  const storageKey = `${randomUUID()}.${format.extension}`;
  await writeFile(path.join(root, storageKey), bytes, { flag: 'wx', mode: 0o600 });
  return storageKey;
}

export async function storeVideo(bytes, format) {
  if (!format || !allowedVideoFormats.includes(format)) throw new Error('El formato del video no es válido.');
  const root = await storageRoot();
  const storageKey = `${randomUUID()}.${format.extension}`;
  await writeFile(path.join(root, storageKey), bytes, { flag: 'wx', mode: 0o600 });
  return storageKey;
}

export async function removeStoredImage(storageKey) {
  const filename = safeStorageFilename(storageKey);
  await rm(path.join(await storageRoot(), filename), { force: true });
}

export async function removeStoredVideo(storageKey) {
  const filename = safeStorageFilename(storageKey, true);
  if (!/\.(?:mp4|webm)$/.test(filename)) throw new Error('La referencia del video no es válida.');
  await rm(path.join(await storageRoot(), filename), { force: true });
}

export async function storedImageMatches(storageKey, expectedBytes) {
  const filename = safeStorageFilename(storageKey);
  const root = await storageRoot();
  const filePath = await realpath(path.join(root, filename));
  if (!isWithin(root, filePath) || !(await stat(filePath)).isFile()) return false;
  return (await readFile(filePath)).equals(expectedBytes);
}

export async function openStoredImage(storageKey) {
  const filename = safeStorageFilename(storageKey);
  const root = await storageRoot();
  const filePath = await realpath(path.join(root, filename));
  if (!isWithin(root, filePath) || !(await stat(filePath)).isFile()) throw new Error('La fotografía no está disponible.');
  return createReadStream(filePath);
}

export async function openStoredVideo(storageKey, range) {
  const filename = safeStorageFilename(storageKey, true);
  if (!/\.(?:mp4|webm)$/.test(filename)) throw new Error('La referencia del video no es válida.');
  const root = await storageRoot();
  const filePath = await realpath(path.join(root, filename));
  const fileStat = await stat(filePath);
  if (!isWithin(root, filePath) || !fileStat.isFile()) throw new Error('El video no está disponible.');
  return { stream: createReadStream(filePath, range ?? {}), size: fileStat.size };
}
