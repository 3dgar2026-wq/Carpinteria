import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v2 as cloudinarySdk } from 'cloudinary';
import { validateMediaStorageConfiguration } from './media-storage-config.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(projectRoot, 'public');
const remoteKeyPattern = /^cloudinary:(image|video):([a-f0-9]{64})$/;
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

function configuredInteger(name, fallback, minimum, maximum, env) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`La configuración ${name} debe ser un entero.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`La configuración ${name} está fuera del rango permitido.`);
  }
  return value;
}

export function validateImageBuffer(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return null;
  return allowedFormats.find((format) => format.matches(bytes)) ?? null;
}

export function validateVideoBuffer(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return null;
  return allowedVideoFormats.find((format) => format.matches(bytes)) ?? null;
}

export function makeMediaIdempotencyKey(...values) {
  const hash = createHash('sha256');
  for (const value of values) {
    if (Buffer.isBuffer(value)) hash.update(value);
    else hash.update(String(value));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function isCloudinaryStorageKey(storageKey) {
  return typeof storageKey === 'string' && remoteKeyPattern.test(storageKey);
}

function parseCloudinaryStorageKey(storageKey, expectedKind) {
  const match = typeof storageKey === 'string' ? remoteKeyPattern.exec(storageKey) : null;
  if (!match || (expectedKind && match[1] !== expectedKind)) {
    const error = new Error('La referencia del archivo multimedia no es válida.');
    error.code = 'INVALID_MEDIA_STORAGE_KEY';
    throw error;
  }
  return {
    kind: match[1],
    id: match[2],
    publicId: `carpinteria/${match[1]}/${match[2]}`,
  };
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function safeStorageFilename(storageKey, includeVideo = false) {
  const extensionPattern = includeVideo ? '(?:jpg|png|webp|mp4|webm)' : '(?:jpg|png|webp)';
  if (typeof storageKey !== 'string' || !new RegExp(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.${extensionPattern}$`).test(storageKey)) {
    const error = new Error('La referencia del archivo multimedia no es válida.');
    error.code = 'INVALID_MEDIA_STORAGE_KEY';
    throw error;
  }
  return storageKey;
}

function mediaError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isConflictError(error) {
  return error?.http_code === 409 || error?.statusCode === 409 || error?.status === 409;
}

function uploadWithCloudinary(client, bytes, kind, publicId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(result);
    };
    let stream;
    try {
      stream = client.uploader.upload_stream({
        resource_type: kind,
        type: 'authenticated',
        public_id: publicId,
        overwrite: false,
        unique_filename: false,
        use_filename: false,
        tags: ['carpinteria'],
      }, finish);
      stream.on('error', (error) => finish(error));
      Readable.from([bytes]).on('error', (error) => finish(error)).pipe(stream);
    } catch (error) {
      finish(error);
    }
  });
}

async function streamMatches(stream, expectedBytes) {
  const expectedHash = createHash('sha256').update(expectedBytes).digest();
  const actualHash = createHash('sha256');
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > expectedBytes.length) {
      stream.destroy?.();
      return false;
    }
    actualHash.update(chunk);
  }
  return size === expectedBytes.length && actualHash.digest().equals(expectedHash);
}

async function collectMediaResponse(response, maximumBytes, validator, kind) {
  if (!response.body) throw mediaError('El recurso multimedia no contiene datos.', 'CLOUDINARY_EMPTY_RESPONSE');
  const stream = Readable.fromWeb(response.body);
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maximumBytes) {
      stream.destroy();
      throw mediaError('El recurso remoto supera el límite configurado.', 'CLOUDINARY_RESOURCE_TOO_LARGE');
    }
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks, size);
  const format = validator(bytes);
  if (!format) throw mediaError('El contenido remoto no coincide con el formato permitido.', 'CLOUDINARY_CONTENT_INVALID');
  return { bytes, format, kind };
}

export function createMediaStorage({
  env = process.env,
  cloudinaryClient = cloudinarySdk,
  fetchImpl = globalThis.fetch,
} = {}) {
  const provider = validateMediaStorageConfiguration(env);

  const maxMediaFileBytes = configuredInteger('MEDIA_MAX_FILE_BYTES', 5 * 1024 * 1024, 1024, 20 * 1024 * 1024, env);
  const maxMediaBatchFiles = configuredInteger('MEDIA_MAX_BATCH_FILES', 100, 1, 100, env);
  const maxVideoFileBytes = configuredInteger('MEDIA_MAX_VIDEO_FILE_BYTES', 50 * 1024 * 1024, 1024, 100 * 1024 * 1024, env);

  const cloudinarySettings = {
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  };
  const hasCloudinarySettings = [cloudinarySettings.cloud_name, cloudinarySettings.api_key, cloudinarySettings.api_secret]
    .every((value) => typeof value === 'string' && value.length > 0);
  let cloudinary = null;
  if (provider === 'cloudinary' && !hasCloudinarySettings) {
    throw new Error('Cloudinary requiere CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY y CLOUDINARY_API_SECRET.');
  }
  if (hasCloudinarySettings) {
    cloudinary = cloudinaryClient;
    cloudinary.config(cloudinarySettings);
  }
  if (provider === 'cloudinary' && typeof fetchImpl !== 'function') {
    throw new Error('El entorno de Node debe proporcionar fetch para servir multimedia de Cloudinary.');
  }

  async function storageRoot() {
    if (env.NODE_ENV === 'production') {
      throw mediaError('El almacenamiento local está deshabilitado en producción.', 'LOCAL_MEDIA_DISABLED_IN_PRODUCTION');
    }
    const configuredRoot = path.resolve(env.MEDIA_STORAGE_DIR || path.join(projectRoot, 'var', 'media'));
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

  function requireCloudinary() {
    if (!cloudinary) throw mediaError('Cloudinary no está configurado para leer este recurso.', 'CLOUDINARY_NOT_CONFIGURED');
    return cloudinary;
  }

  function assertStoredMediaKeyAllowed(storageKey, includeVideo = false) {
    if (isCloudinaryStorageKey(storageKey)) return;
    if (env.NODE_ENV === 'production') {
      throw mediaError('Las referencias multimedia locales no están disponibles en producción.', 'LOCAL_MEDIA_DISABLED_IN_PRODUCTION');
    }
    safeStorageFilename(storageKey, includeVideo);
  }

  function cloudinaryUrl(storageKey, expectedKind) {
    const entry = parseCloudinaryStorageKey(storageKey, expectedKind);
    const client = requireCloudinary();
    const url = client.url(entry.publicId, {
      resource_type: entry.kind,
      type: 'authenticated',
      sign_url: true,
      secure: true,
    });
    return { ...entry, url };
  }

  async function fetchCloudinary(storageKey, { kind, method = 'GET', range } = {}) {
    const entry = cloudinaryUrl(storageKey, kind);
    let response;
    try {
      response = await fetchImpl(entry.url, {
        method,
        redirect: 'follow',
        ...(range ? { headers: { Range: `bytes=${range.start}-${range.end}` } } : {}),
      });
    } catch {
      throw mediaError('No fue posible comunicarse con el almacenamiento multimedia.', 'CLOUDINARY_NETWORK_ERROR');
    }
    if (response.status === 404) throw mediaError('El recurso multimedia remoto no existe.', 'ENOENT');
    if (!response.ok && !(range && response.status === 206)) {
      throw mediaError('El almacenamiento multimedia rechazó la solicitud.', 'CLOUDINARY_HTTP_ERROR');
    }
    if (range) {
      const contentRange = response.headers.get('content-range') ?? '';
      if (response.status !== 206 || !contentRange.startsWith(`bytes ${range.start}-${range.end}/`)) {
        await response.body?.cancel().catch(() => {});
        throw mediaError('Cloudinary no respetó el rango solicitado para el video.', 'CLOUDINARY_RANGE_MISMATCH');
      }
    }
    return response;
  }

  async function uploadRemote(bytes, format, kind, idempotencyKey) {
    const client = requireCloudinary();
    const id = idempotencyKey ?? randomBytes(32).toString('hex');
    if (!/^[a-f0-9]{32,64}$/i.test(id)) throw mediaError('La clave idempotente de multimedia no es válida.', 'INVALID_MEDIA_IDEMPOTENCY_KEY');
    const storageKey = `cloudinary:${kind}:${id.toLowerCase()}`;
    const { publicId } = parseCloudinaryStorageKey(storageKey, kind);
    try {
      const result = await uploadWithCloudinary(client, bytes, kind, publicId);
      if (!result || result.public_id !== publicId || result.resource_type !== kind
        || result.type !== 'authenticated' || result.bytes !== bytes.length) {
        throw mediaError('Cloudinary devolvió metadatos de carga inconsistentes.', 'CLOUDINARY_UPLOAD_VERIFY_FAILED');
      }
      return storageKey;
    } catch (error) {
      if (!isConflictError(error)) {
        if (error?.code && /^[A-Z0-9_]{1,40}$/.test(error.code)) throw error;
        throw mediaError('No fue posible subir el archivo a Cloudinary.', 'CLOUDINARY_UPLOAD_FAILED');
      }
      const matches = kind === 'image'
        ? await storedImageMatches(storageKey, bytes)
        : await storedVideoMatches(storageKey, bytes);
      if (matches) return storageKey;
      throw mediaError('El identificador idempotente ya existe con un contenido distinto.', 'CLOUDINARY_IDEMPOTENCY_CONFLICT');
    }
  }

  async function snapshotRemote(storageKey, kind, maximumBytes) {
    let response;
    try { response = await fetchCloudinary(storageKey, { kind }); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    return collectMediaResponse(response, maximumBytes,
      kind === 'image' ? validateImageBuffer : validateVideoBuffer, kind);
  }

  async function restoreRemote(storageKey, bytes, kind) {
    const { id } = parseCloudinaryStorageKey(storageKey, kind);
    const format = kind === 'image' ? validateImageBuffer(bytes) : validateVideoBuffer(bytes);
    if (!format) throw mediaError('El respaldo temporal no tiene un formato válido.', 'MEDIA_RESTORE_INVALID');
    await uploadRemote(bytes, format, kind, id);
  }

  async function storeImage(bytes, format, { idempotencyKey } = {}) {
    if (!format || !allowedFormats.includes(format)) throw new Error('El formato de la imagen no es válido.');
    if (provider === 'cloudinary') return uploadRemote(bytes, format, 'image', idempotencyKey);
    const root = await storageRoot();
    const storageKey = `${randomUUID()}.${format.extension}`;
    await writeFile(path.join(root, storageKey), bytes, { flag: 'wx', mode: 0o600 });
    return storageKey;
  }

  async function storeVideo(bytes, format, { idempotencyKey } = {}) {
    if (!format || !allowedVideoFormats.includes(format)) throw new Error('El formato del video no es válido.');
    if (provider === 'cloudinary') return uploadRemote(bytes, format, 'video', idempotencyKey);
    const root = await storageRoot();
    const storageKey = `${randomUUID()}.${format.extension}`;
    await writeFile(path.join(root, storageKey), bytes, { flag: 'wx', mode: 0o600 });
    return storageKey;
  }

  async function removeRemote(storageKey, kind) {
    const entry = parseCloudinaryStorageKey(storageKey, kind);
    let result;
    try {
      result = await requireCloudinary().uploader.destroy(entry.publicId, {
        resource_type: kind,
        type: 'authenticated',
        invalidate: true,
      });
    } catch {
      throw mediaError('No fue posible confirmar la eliminación del recurso remoto.', 'CLOUDINARY_DELETE_FAILED');
    }
    if (result?.result === 'ok' || result?.result === 'not found') return;
    throw mediaError('Cloudinary no confirmó la eliminación del recurso.', 'CLOUDINARY_DELETE_UNCONFIRMED');
  }

  async function removeStoredImage(storageKey) {
    if (isCloudinaryStorageKey(storageKey)) return removeRemote(storageKey, 'image');
    assertStoredMediaKeyAllowed(storageKey);
    const filename = safeStorageFilename(storageKey);
    await rm(path.join(await storageRoot(), filename), { force: true });
  }

  async function removeStoredVideo(storageKey) {
    if (isCloudinaryStorageKey(storageKey)) return removeRemote(storageKey, 'video');
    assertStoredMediaKeyAllowed(storageKey, true);
    const filename = safeStorageFilename(storageKey, true);
    if (!/\.(?:mp4|webm)$/.test(filename)) throw new Error('La referencia del video no es válida.');
    await rm(path.join(await storageRoot(), filename), { force: true });
  }

  async function snapshotStoredImage(storageKey) {
    if (!isCloudinaryStorageKey(storageKey)) {
      assertStoredMediaKeyAllowed(storageKey);
      return null;
    }
    return snapshotRemote(storageKey, 'image', maxMediaFileBytes);
  }

  async function restoreStoredImage(storageKey, bytes) {
    if (!isCloudinaryStorageKey(storageKey)) {
      assertStoredMediaKeyAllowed(storageKey);
      return;
    }
    await restoreRemote(storageKey, bytes, 'image');
  }

  async function snapshotStoredVideo(storageKey) {
    if (!isCloudinaryStorageKey(storageKey)) {
      assertStoredMediaKeyAllowed(storageKey, true);
      return null;
    }
    return snapshotRemote(storageKey, 'video', maxVideoFileBytes);
  }

  async function restoreStoredVideo(storageKey, bytes) {
    if (!isCloudinaryStorageKey(storageKey)) {
      assertStoredMediaKeyAllowed(storageKey, true);
      return;
    }
    await restoreRemote(storageKey, bytes, 'video');
  }

  async function storedMediaMatches(storageKey, expectedBytes, kind) {
    if (isCloudinaryStorageKey(storageKey)) {
      try {
        const response = await fetchCloudinary(storageKey, { kind });
        if (!response.body) return false;
        return streamMatches(Readable.fromWeb(response.body), expectedBytes);
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    }
    assertStoredMediaKeyAllowed(storageKey, kind === 'video');
    const filename = safeStorageFilename(storageKey, kind === 'video');
    const root = await storageRoot();
    const filePath = await realpath(path.join(root, filename));
    if (!isWithin(root, filePath) || !(await stat(filePath)).isFile()) return false;
    return (await readFile(filePath)).equals(expectedBytes);
  }

  async function storedImageMatches(storageKey, expectedBytes) {
    return storedMediaMatches(storageKey, expectedBytes, 'image');
  }

  async function storedVideoMatches(storageKey, expectedBytes) {
    return storedMediaMatches(storageKey, expectedBytes, 'video');
  }

  async function openStoredImage(storageKey) {
    if (isCloudinaryStorageKey(storageKey)) {
      const response = await fetchCloudinary(storageKey, { kind: 'image' });
      if (!response.body) throw mediaError('El recurso multimedia no contiene datos.', 'CLOUDINARY_EMPTY_RESPONSE');
      return Readable.fromWeb(response.body);
    }
    assertStoredMediaKeyAllowed(storageKey);
    const filename = safeStorageFilename(storageKey);
    const root = await storageRoot();
    const filePath = await realpath(path.join(root, filename));
    if (!isWithin(root, filePath) || !(await stat(filePath)).isFile()) throw new Error('La fotografía no está disponible.');
    return createReadStream(filePath);
  }

  async function getStoredVideoSize(storageKey) {
    if (isCloudinaryStorageKey(storageKey)) {
      const response = await fetchCloudinary(storageKey, { kind: 'video', method: 'HEAD' });
      const size = Number(response.headers.get('content-length'));
      if (!Number.isSafeInteger(size) || size < 1) throw mediaError('Cloudinary no devolvió el tamaño del video.', 'CLOUDINARY_SIZE_MISSING');
      return size;
    }
    assertStoredMediaKeyAllowed(storageKey, true);
    const filename = safeStorageFilename(storageKey, true);
    if (!/\.(?:mp4|webm)$/.test(filename)) throw new Error('La referencia del video no es válida.');
    const root = await storageRoot();
    const filePath = await realpath(path.join(root, filename));
    const fileStat = await stat(filePath);
    if (!isWithin(root, filePath) || !fileStat.isFile()) throw new Error('El video no está disponible.');
    return fileStat.size;
  }

  async function openStoredVideo(storageKey, range) {
    if (isCloudinaryStorageKey(storageKey)) {
      const response = await fetchCloudinary(storageKey, { kind: 'video', range });
      if (!response.body) throw mediaError('El recurso multimedia no contiene datos.', 'CLOUDINARY_EMPTY_RESPONSE');
      return { stream: Readable.fromWeb(response.body) };
    }
    assertStoredMediaKeyAllowed(storageKey, true);
    const filename = safeStorageFilename(storageKey, true);
    if (!/\.(?:mp4|webm)$/.test(filename)) throw new Error('La referencia del video no es válida.');
    const root = await storageRoot();
    const filePath = await realpath(path.join(root, filename));
    const fileStat = await stat(filePath);
    if (!isWithin(root, filePath) || !fileStat.isFile()) throw new Error('El video no está disponible.');
    return { stream: createReadStream(filePath, range ?? {}), size: fileStat.size };
  }

  return {
    provider,
    maxMediaFileBytes,
    maxMediaBatchFiles,
    maxVideoFileBytes,
    storeImage,
    storeVideo,
    removeStoredImage,
    removeStoredVideo,
    snapshotStoredImage,
    snapshotStoredVideo,
    restoreStoredImage,
    restoreStoredVideo,
    storedImageMatches,
    storedVideoMatches,
    openStoredImage,
    assertStoredMediaKeyAllowed,
    getStoredVideoSize,
    openStoredVideo,
  };
}

const defaultStorage = createMediaStorage();
export const mediaStorageProvider = defaultStorage.provider;
export const maxMediaFileBytes = defaultStorage.maxMediaFileBytes;
export const maxMediaBatchFiles = defaultStorage.maxMediaBatchFiles;
export const maxVideoFileBytes = defaultStorage.maxVideoFileBytes;
export const storeImage = defaultStorage.storeImage;
export const storeVideo = defaultStorage.storeVideo;
export const removeStoredImage = defaultStorage.removeStoredImage;
export const removeStoredVideo = defaultStorage.removeStoredVideo;
export const snapshotStoredImage = defaultStorage.snapshotStoredImage;
export const snapshotStoredVideo = defaultStorage.snapshotStoredVideo;
export const restoreStoredImage = defaultStorage.restoreStoredImage;
export const restoreStoredVideo = defaultStorage.restoreStoredVideo;
export const storedImageMatches = defaultStorage.storedImageMatches;
export const storedVideoMatches = defaultStorage.storedVideoMatches;
export const openStoredImage = defaultStorage.openStoredImage;
export const assertStoredMediaKeyAllowed = defaultStorage.assertStoredMediaKeyAllowed;
export const getStoredVideoSize = defaultStorage.getStoredVideoSize;
export const openStoredVideo = defaultStorage.openStoredVideo;
