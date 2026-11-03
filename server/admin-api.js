import express from 'express';
import { randomUUID } from 'node:crypto';
import { pool, query } from './db.js';
import { validatePricingRule, InvalidPricingRuleError } from './pricing.js';
import { normalizeFixedDimensions } from './fixed-dimensions.js';
import { hasVerifiablePublicMediaColumns } from './media-schema.js';
import {
  maxMediaBatchFiles,
  maxMediaFileBytes,
  maxVideoFileBytes,
  getStoredVideoSize,
  assertStoredMediaKeyAllowed,
  isCloudinaryStorageKey,
  makeMediaIdempotencyKey,
  openStoredImage,
  openStoredVideo,
  removeStoredImage,
  removeStoredVideo,
  restoreStoredImage,
  restoreStoredVideo,
  snapshotStoredImage,
  snapshotStoredVideo,
  storeImage,
  storeVideo,
  storedImageMatches,
  validateImageBuffer,
  validateVideoBuffer,
} from './media-storage.js';
import {
  AdminInputError,
  auditAdminAction,
  createAdminApiRouter,
  withAdminTransaction,
} from './admin-auth.js';

const router = createAdminApiRouter();
const standardDimensionKeys = new Set(['width_m', 'height_m', 'depth_m', 'length_m', 'thickness_m']);
const maximumMeasurementCount = 12;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const idPattern = /^[1-9]\d{0,18}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function objectBody(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function validDimensionKey(value) {
  return standardDimensionKeys.has(value) || (typeof value === 'string' && /^custom_[a-f0-9]{32}$/.test(value));
}

function requiredText(value, label, maximumLength) {
  if (typeof value !== 'string') throw new AdminInputError(`${label}: escribe un texto válido.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength) {
    throw new AdminInputError(`${label}: debe tener entre 1 y ${maximumLength} caracteres.`);
  }
  return normalized;
}

function optionalText(value, label, maximumLength) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > maximumLength) {
    throw new AdminInputError(`${label}: no puede superar ${maximumLength} caracteres.`);
  }
  return value.trim() || null;
}

function validatedSlug(value) {
  const slug = requiredText(value, 'El identificador', 120);
  if (!slugPattern.test(slug)) {
    throw new AdminInputError('El identificador solo puede usar minúsculas, números y guiones simples.');
  }
  return slug;
}

function validatedId(value, label = 'El identificador') {
  const id = String(value ?? '');
  if (!idPattern.test(id) || (id.length === 19 && id > '9223372036854775807')) {
    throw new AdminInputError(`${label} no es válido.`);
  }
  return id;
}

function validatedMediaIds(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxMediaBatchFiles) {
    throw new AdminInputError(`Selecciona entre 1 y ${maxMediaBatchFiles} fotografías.`);
  }
  const ids = value.map((id) => validatedId(id, 'La fotografía'));
  if (new Set(ids).size !== ids.length) throw new AdminInputError('La selección contiene fotografías repetidas.');
  return ids;
}

function safeOriginalFilename(value) {
  let filename = '';
  try {
    filename = decodeURIComponent(String(value ?? ''));
  } catch {
    throw new AdminInputError('El nombre del archivo no es válido.');
  }
  filename = filename.replaceAll('\\', '/').split('/').at(-1)
    .replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  return filename || 'Fotografía';
}

function mediaSizeLabel(bytes) {
  if (bytes >= 1024 * 1024) return `${Number((bytes / (1024 * 1024)).toFixed(1))} MB`;
  return `${Math.ceil(bytes / 1024)} KB`;
}

function logMediaFailure(operation, error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code)
    ? ` código=${error.code}`
    : '';
  console.error(`Falló la operación multimedia (${operation}).${code}`);
}

function slugFromProductName(name) {
  const slug = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 120);
  if (!slug) throw new AdminInputError('El nombre debe incluir letras o números para crear el identificador del producto.');
  return slug;
}

async function sendMediaFile(response, storageKey, mimeType, cacheControl) {
  response.set({
    'Content-Type': mimeType,
    'Content-Disposition': 'inline',
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff',
  });
  const stream = await openStoredImage(storageKey);
  stream.on('error', () => {
    if (!response.headersSent) response.status(404).json({ error: 'No se encontró la fotografía.' });
    else response.destroy();
  });
  stream.pipe(response);
}

async function streamVideo(request, response, storageKey, mimeType) {
  const size = await getStoredVideoSize(storageKey);
  const header = request.get('Range');
  let range = null;
  if (header) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(header);
    if (!match || (!match[1] && !match[2])) {
      response.set('Content-Range', `bytes */${size}`).status(416).end();
      return;
    }
    const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    const end = match[2] && match[1] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) {
      response.set('Content-Range', `bytes */${size}`).status(416).end();
      return;
    }
    range = { start, end };
  }
  const { stream } = await openStoredVideo(storageKey, range ?? undefined);
  response.set({
    'Content-Type': mimeType,
    'Content-Disposition': 'inline',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
    'Content-Length': String(range ? range.end - range.start + 1 : size),
    ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${size}` } : {}),
  });
  if (range) response.status(206);
  stream.on('error', () => response.destroy());
  stream.pipe(response);
}

function validatedMeasurementConfig(config) {
  if (config === null || config === undefined) return null;
  if (!objectBody(config) || config.version !== 1 || !Array.isArray(config.dimensions)
    || config.dimensions.length < 1 || config.dimensions.length > maximumMeasurementCount) {
    throw new AdminInputError(`La configuración debe tener versión 1 y entre 1 y ${maximumMeasurementCount} medidas.`);
  }

  const seen = new Set();
  const dimensions = config.dimensions.map((dimension) => {
    if (!objectBody(dimension) || !validDimensionKey(dimension.key) || seen.has(dimension.key)) {
      throw new AdminInputError('Hay una medida desconocida o repetida.');
    }
    seen.add(dimension.key);
    const label = requiredText(dimension.label, 'El nombre de la medida', 60);
    const hasMinimum = dimension.min_m !== undefined && dimension.min_m !== null;
    const min = hasMinimum ? dimension.min_m : 0;
    const max = dimension.max_m;
    const hasMaximum = max !== undefined && max !== null;
    if (typeof min !== 'number' || !Number.isFinite(min) || min < 0
      || (hasMaximum && (typeof max !== 'number' || !Number.isFinite(max) || max < 0 || min > max))) {
      throw new AdminInputError('Los límites deben ser números no negativos y el mínimo no puede superar el máximo.');
    }
    if (dimension.required !== undefined && typeof dimension.required !== 'boolean') {
      throw new AdminInputError('Indica si la dimensión es obligatoria.');
    }
    const normalized = {
      key: dimension.key,
      label,
      help: optionalText(dimension.help, 'La explicación de medida', 300) ?? '',
      required: dimension.required !== false,
    };
    if (hasMinimum) normalized.min_m = min;
    if (hasMaximum) normalized.max_m = max;
    return normalized;
  });

  return { version: 1, dimensions };
}

function validatedFixedDimensions(config) {
  if (config === null || config === undefined) return null;
  const normalized = normalizeFixedDimensions(config);
  if (!normalized) {
    throw new AdminInputError('Revisa los nombres y valores de las dimensiones fijas. Usa metros y hasta doce elementos.');
  }
  return normalized;
}

function validatedProductPrice(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 9999999999.99
    || Math.abs(value * 100 - Math.round(value * 100)) > 0.000001) {
    throw new AdminInputError('El precio debe ser un número no negativo con máximo dos decimales.');
  }
  return value;
}

function validatedPricingRule(rule) {
  if (rule === null || rule === undefined) return null;
  try {
    validatePricingRule(rule);
  } catch (error) {
    if (error instanceof InvalidPricingRuleError) {
      throw new AdminInputError('La regla de precio no coincide con el formato documentado.');
    }
    throw error;
  }
  return rule;
}

function pricingFields(rule, fields = new Set()) {
  if (!rule) return fields;
  function visit(node) {
    if (Object.hasOwn(node, 'field')) fields.add(node.field);
    else if (Array.isArray(node.args)) node.args.forEach(visit);
  }
  visit(rule.expression);
  return fields;
}

function assertPricingFieldsConfigured(rule, measurementConfig) {
  const configuredDimensions = new Set(measurementConfig?.dimensions.map((dimension) => dimension.key) ?? []);
  if ([...pricingFields(rule)].some((field) => !configuredDimensions.has(field))) {
    throw new AdminInputError('Configura cada dimensión usada por la regla de precio.');
  }
}

function parseConfig(body, key, validator, label) {
  if (!Object.hasOwn(body, key)) throw new AdminInputError(`Falta la configuración: ${label}.`);
  return validator(body[key]);
}

async function categoryIdFromBody(client, body) {
  const categoryId = validatedId(body.categoryId, 'La categoría');
  const { rows } = await client.query(
    'SELECT id, pricing_rules FROM categories WHERE id = $1 FOR SHARE',
    [categoryId],
  );
  if (!rows.length) throw new AdminInputError('Selecciona una categoría existente.');
  return rows[0];
}

router.get('/categories', async (_request, response) => {
  try {
    const { rows } = await query(`
      SELECT id, parent_id, name, slug, description, sort_order, is_active, pricing_rules, measurement_template
      FROM categories
      ORDER BY sort_order, name
    `);
    response.json({ categories: rows });
  } catch {
    response.status(503).json({ error: 'No fue posible cargar las categorías.' });
  }
});

router.post('/categories', async (request, response) => {
  if (!objectBody(request.body)) return response.status(400).json({ error: 'Revisa los datos de la categoría.' });
  const result = await withAdminTransaction(response, async (client) => {
    const name = requiredText(request.body.name, 'El nombre', 160);
    const slug = validatedSlug(request.body.slug);
    const description = optionalText(request.body.description, 'La descripción', 3000);
    const pricingRules = parseConfig(request.body, 'pricingRules', validatedPricingRule, 'precio');
    const measurementTemplate = Object.hasOwn(request.body, 'measurementTemplate')
      ? validatedMeasurementConfig(request.body.measurementTemplate)
      : null;
    const { rows } = await client.query(`
      INSERT INTO categories (name, slug, description, pricing_rules, measurement_template)
      VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
      RETURNING id, name, slug, description, is_active, pricing_rules, measurement_template
    `, [name, slug, description, pricingRules === null ? null : JSON.stringify(pricingRules), measurementTemplate === null ? null : JSON.stringify(measurementTemplate)]);
    const category = rows[0];
    await auditAdminAction(client, request.adminSession.id, 'category.created', 'category', category.id, {
      slug,
      isActive: category.is_active,
      measurementCount: measurementTemplate?.dimensions.length ?? 0,
    });
    return category;
  });
  if (result !== null) response.status(201).json({ category: result, message: 'Categoría creada.' });
});

router.patch('/categories/:id', async (request, response) => {
  if (!objectBody(request.body)) return response.status(400).json({ error: 'Revisa los datos de la categoría.' });
  const result = await withAdminTransaction(response, async (client) => {
    const id = validatedId(request.params.id);
    const name = requiredText(request.body.name, 'El nombre', 160);
    const slug = validatedSlug(request.body.slug);
    const description = optionalText(request.body.description, 'La descripción', 3000);
    const pricingRules = parseConfig(request.body, 'pricingRules', validatedPricingRule, 'precio');
    const hasMeasurementTemplate = Object.hasOwn(request.body, 'measurementTemplate');
    const measurementTemplate = hasMeasurementTemplate
      ? validatedMeasurementConfig(request.body.measurementTemplate)
      : null;
    const categoryId = id;
    const { rows: categoryLockRows } = await client.query(
      'SELECT id FROM categories WHERE id = $1 FOR UPDATE',
      [categoryId],
    );
    if (!categoryLockRows.length) throw new AdminInputError('No se encontró la categoría.', 404);
    const { rows: linkedProducts } = await client.query(
      'SELECT measurement_config, pricing_rules FROM products WHERE category_id = $1',
      [categoryId],
    );
    for (const product of linkedProducts) {
      assertPricingFieldsConfigured(product.pricing_rules ?? pricingRules, product.measurement_config);
    }
    if (typeof request.body.isActive !== 'boolean') {
      throw new AdminInputError('Indica si la categoría está activa.');
    }
    if (!request.body.isActive) {
      const { rows: publishedRows } = await client.query(
        'SELECT 1 FROM products WHERE category_id = $1 AND is_published = TRUE LIMIT 1',
        [categoryId],
      );
      if (publishedRows.length) {
        throw new AdminInputError('Despublica primero los trabajos de esta categoría.', 409);
      }
    }
    const { rows } = await client.query(`
      UPDATE categories
      SET name = $2, slug = $3, description = $4, pricing_rules = $5::jsonb,
          is_active = $6,
          measurement_template = CASE WHEN $7 THEN $8::jsonb ELSE measurement_template END,
          updated_at = now()
      WHERE id = $1
      RETURNING id, name, slug, description, is_active, pricing_rules, measurement_template
    `, [categoryId, name, slug, description, pricingRules === null ? null : JSON.stringify(pricingRules), request.body.isActive,
      hasMeasurementTemplate, measurementTemplate === null ? null : JSON.stringify(measurementTemplate)]);
    if (!rows.length) throw new AdminInputError('No se encontró la categoría.', 404);
    await auditAdminAction(client, request.adminSession.id, 'category.updated', 'category', categoryId, {
      slug,
      isActive: request.body.isActive,
      ...(hasMeasurementTemplate ? { measurementCount: measurementTemplate?.dimensions.length ?? 0 } : {}),
    });
    return rows[0];
  });
  if (result !== null) response.json({ category: result, message: 'Categoría actualizada.' });
});

router.delete('/categories/:id', async (request, response) => {
  const result = await withAdminTransaction(response, async (client) => {
    const id = validatedId(request.params.id, 'La categoría');
    const { rows: categoryRows } = await client.query(`
      SELECT id, slug, pricing_rules IS NOT NULL AS has_pricing_rules,
             measurement_template IS NOT NULL AS has_measurement_template
      FROM categories
      WHERE id = $1
      FOR UPDATE
    `, [id]);
    const category = categoryRows[0];
    if (!category) throw new AdminInputError('No se encontró la categoría.', 404);

    const { rows: productRows } = await client.query(
      'SELECT 1 FROM products WHERE category_id = $1 LIMIT 1',
      [id],
    );
    if (productRows.length) {
      throw new AdminInputError('No se puede eliminar esta categoría porque tiene trabajos asociados. Abre cada trabajo desde “Ver dependencias”, edítalo y asígnalo a otra categoría antes de volver a intentarlo.', 409);
    }

    const { rows: childRows } = await client.query(
      'SELECT 1 FROM categories WHERE parent_id = $1 LIMIT 1',
      [id],
    );
    if (childRows.length) {
      throw new AdminInputError('No se puede eliminar esta categoría porque tiene subcategorías. Gestiona cada una desde “Ver dependencias”; resuelve lo que tenga asociado y elimínala antes de volver a intentarlo.', 409);
    }

    if (category.has_measurement_template || category.has_pricing_rules) {
      throw new AdminInputError('No se puede eliminar esta categoría porque conserva una plantilla de medidas o una regla de precio. Edita la categoría y retira esa configuración de forma explícita antes de eliminarla.', 409);
    }

    try {
      await client.query('DELETE FROM categories WHERE id = $1', [id]);
    } catch (error) {
      if (error.code === '23503') {
        throw new AdminInputError('No se puede eliminar esta categoría porque todavía tiene elementos asociados. Revisa sus trabajos y subcategorías.', 409);
      }
      throw error;
    }
    await auditAdminAction(client, request.adminSession.id, 'category.deleted', 'category', id, {
      slug: category.slug,
    });
    return { message: 'Categoría eliminada.' };
  });
  if (result !== null) response.json(result);
});

router.get('/media', async (request, response) => {
  const pageValue = Number(request.query.page ?? 1);
  if (!Number.isSafeInteger(pageValue) || pageValue < 1 || pageValue > 100000) {
    return response.status(400).json({ error: 'La página solicitada no es válida.' });
  }
  const search = typeof request.query.q === 'string' ? request.query.q.trim().slice(0, 100) : '';
  const pattern = `%${search}%`;
  const limit = 24;
  const offset = (pageValue - 1) * limit;
  try {
    const { rows: countRows } = await query(`
      SELECT count(*)::integer AS total
      FROM media_assets ma
      WHERE ma.media_kind = 'image' AND ma.classification_status = 'pending'
        AND NOT EXISTS (SELECT 1 FROM product_media pm WHERE pm.media_asset_id = ma.id)
        AND ($1 = '' OR ma.original_filename ILIKE $2)
    `, [search, pattern]);
    const { rows } = await query(`
      SELECT ma.id, ma.original_filename, ma.mime_type, ma.byte_size, ma.created_at
      FROM media_assets ma
      WHERE ma.media_kind = 'image' AND ma.classification_status = 'pending'
        AND NOT EXISTS (SELECT 1 FROM product_media pm WHERE pm.media_asset_id = ma.id)
        AND ($1 = '' OR ma.original_filename ILIKE $2)
      ORDER BY ma.created_at DESC, ma.id DESC
      LIMIT $3 OFFSET $4
    `, [search, pattern, limit, offset]);
    const total = countRows[0]?.total ?? 0;
    response.json({
      media: rows.map((media) => ({ ...media, adminUrl: `/api/admin/media/${media.id}/content` })),
      page: pageValue,
      pageSize: limit,
      total,
      maxFileBytes: maxMediaFileBytes,
      maxFilesPerBatch: maxMediaBatchFiles,
    });
  } catch {
    response.status(503).json({ error: 'No fue posible cargar las fotografías pendientes.' });
  }
});

router.get('/media/library', async (request, response) => {
  const pageValue = Number(request.query.page ?? 1);
  if (!Number.isSafeInteger(pageValue) || pageValue < 1 || pageValue > 100000) {
    return response.status(400).json({ error: 'La página solicitada no es válida.' });
  }
  const search = typeof request.query.q === 'string' ? request.query.q.trim().slice(0, 100) : '';
  const pattern = `%${search}%`;
  const limit = 24;
  const offset = (pageValue - 1) * limit;
  try {
    const { rows: countRows } = await query(`
      SELECT count(*)::integer AS total
      FROM media_assets ma
      WHERE ma.media_kind = 'image'
        AND ($1 = '' OR ma.original_filename ILIKE $2 OR EXISTS (
          SELECT 1 FROM product_media pm
          JOIN products p ON p.id = pm.product_id
          WHERE pm.media_asset_id = ma.id AND p.name ILIKE $2
        ))
    `, [search, pattern]);
    const { rows } = await query(`
      SELECT ma.id, ma.original_filename, ma.mime_type, ma.byte_size,
             ma.classification_status, ma.is_public, ma.created_at,
             COALESCE(
               json_agg(json_build_object(
                 'id', p.id,
                 'name', p.name,
                 'isPublished', p.is_published
               ) ORDER BY p.name) FILTER (WHERE p.id IS NOT NULL),
               '[]'::json
             ) AS products
      FROM media_assets ma
      LEFT JOIN product_media pm ON pm.media_asset_id = ma.id
      LEFT JOIN products p ON p.id = pm.product_id
      WHERE ma.media_kind = 'image'
        AND ($1 = '' OR ma.original_filename ILIKE $2 OR EXISTS (
          SELECT 1 FROM product_media pm_search
          JOIN products p_search ON p_search.id = pm_search.product_id
          WHERE pm_search.media_asset_id = ma.id AND p_search.name ILIKE $2
        ))
      GROUP BY ma.id
      ORDER BY ma.created_at DESC, ma.id DESC
      LIMIT $3 OFFSET $4
    `, [search, pattern, limit, offset]);
    response.json({
      media: rows.map((media) => ({ ...media, adminUrl: `/api/admin/media/${media.id}/content` })),
      page: pageValue,
      pageSize: limit,
      total: countRows[0]?.total ?? 0,
    });
  } catch {
    response.status(503).json({ error: 'No fue posible cargar la biblioteca de imágenes.' });
  }
});

router.get('/media/:id/content', async (request, response) => {
  let id;
  try {
    id = validatedId(request.params.id, 'La fotografía');
  } catch (error) {
    return response.status(error.status ?? 400).json({ error: error.message ?? 'La fotografía no es válida.' });
  }
  try {
    const { rows } = await query(`
      SELECT storage_key, mime_type
      FROM media_assets
      WHERE id = $1 AND media_kind = 'image'
    `, [id]);
    if (!rows.length || !['image/jpeg', 'image/png', 'image/webp'].includes(rows[0].mime_type)) {
      return response.status(404).json({ error: 'No se encontró la fotografía.' });
    }
    await sendMediaFile(response, rows[0].storage_key, rows[0].mime_type, 'private, no-store');
  } catch (error) {
    if (!response.headersSent) {
      const unavailable = error?.code && error.code !== 'ENOENT';
      response.status(unavailable ? 503 : 404).json({
        error: unavailable ? 'No fue posible recuperar la fotografía.' : 'No se encontró la fotografía.',
      });
    }
  }
});

router.post('/media/upload/:batchId', express.raw({ type: 'application/octet-stream', limit: maxMediaFileBytes, inflate: false }), async (request, response) => {
  const batchId = String(request.params.batchId ?? '');
  if (!uuidPattern.test(batchId)) return response.status(400).json({ error: 'El lote de fotografías no es válido.' });
  if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
    return response.status(400).json({ error: 'Selecciona un archivo de imagen.' });
  }
  const format = validateImageBuffer(request.body);
  if (!format) return response.status(415).json({ error: 'Usa una fotografía JPG, PNG o WebP válida.' });

  let originalFilename;
  try {
    originalFilename = safeOriginalFilename(request.get('X-Original-Filename'));
  } catch (error) {
    return response.status(error.status ?? 400).json({ error: error.message ?? 'El nombre del archivo no es válido.' });
  }

  let storageKey;
  let commitAttempted = false;
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [batchId]);
    const { rows: possibleDuplicates } = await client.query(`
      SELECT id, storage_key, original_filename, mime_type, byte_size, created_at,
             classification_status, is_public
      FROM media_assets
      WHERE upload_batch_id = $1 AND original_filename = $2
        AND mime_type = $3 AND byte_size = $4
      ORDER BY id
    `, [batchId, originalFilename, format.mimeType, request.body.length]);
    for (const existing of possibleDuplicates) {
      let identical = false;
      try {
        identical = await storedImageMatches(existing.storage_key, request.body);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (!identical) continue;
      await client.query('COMMIT');
      commitAttempted = true;
      response.status(200).json({
        duplicate: true,
        media: {
          id: existing.id,
          original_filename: existing.original_filename,
          mime_type: existing.mime_type,
          byte_size: existing.byte_size,
          created_at: existing.created_at,
          classification_status: existing.classification_status,
          is_public: existing.is_public,
          adminUrl: `/api/admin/media/${existing.id}/content`,
        },
      });
      return;
    }
    const { rows: countRows } = await client.query(
      'SELECT count(*)::integer AS total FROM media_assets WHERE upload_batch_id = $1',
      [batchId],
    );
    if (countRows[0].total >= maxMediaBatchFiles) {
      throw new AdminInputError(`Un lote puede tener como máximo ${maxMediaBatchFiles} fotografías.`);
    }
    storageKey = await storeImage(request.body, format, {
      idempotencyKey: makeMediaIdempotencyKey('image', batchId, originalFilename, format.mimeType, request.body),
    });
    const { rows } = await client.query(`
      INSERT INTO media_assets (
        storage_key, media_kind, mime_type, original_filename,
        classification_status, upload_batch_id, byte_size, is_public
      ) VALUES ($1, 'image', $2, $3, 'pending', $4, $5, FALSE)
      RETURNING id, original_filename, mime_type, byte_size, created_at
    `, [storageKey, format.mimeType, originalFilename, batchId, request.body.length]);
    const media = rows[0];
    await auditAdminAction(client, request.adminSession.id, 'media.uploaded.pending', 'media_asset', media.id, {
      byteSize: request.body.length,
      mimeType: format.mimeType,
    });
    commitAttempted = true;
    await client.query('COMMIT');
    response.status(201).json({ media: { ...media, adminUrl: `/api/admin/media/${media.id}/content` } });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    if (storageKey && !commitAttempted) {
      try { await removeStoredImage(storageKey); }
      catch (cleanupError) { logMediaFailure('limpieza de carga interrumpida', cleanupError); }
    }
    if (!(error instanceof AdminInputError)) logMediaFailure('carga de imagen', error);
    if (error instanceof AdminInputError) return response.status(error.status).json({ error: error.message });
    if (error.code === '23503' || error.code === '23514') {
      return response.status(400).json({ error: 'No se pudo guardar la fotografía con los datos actuales.' });
    }
    response.status(503).json({ error: 'No fue posible guardar esta fotografía. Puedes volver a intentarlo.' });
  } finally {
    client?.release();
  }
});

router.delete('/media/:id', async (request, response) => {
  const remoteBackups = [];
  const result = await withAdminTransaction(response, async (client) => {
    const id = validatedId(request.params.id, 'La fotografía');
    const { rows } = await client.query(`
      SELECT id, media_kind, classification_status, storage_key, original_filename, mime_type
      FROM media_assets
      WHERE id = $1
      FOR UPDATE
    `, [id]);
    const media = rows[0];
    if (!media || media.media_kind !== 'image') throw new AdminInputError('No se encontró la fotografía pendiente.', 404);
    assertStoredMediaKeyAllowed(media.storage_key);
    const { rows: links } = await client.query(`
      SELECT p.name, p.is_published
      FROM product_media pm
      JOIN products p ON p.id = pm.product_id
      WHERE pm.media_asset_id = $1
      ORDER BY p.name
    `, [id]);
    if (links.length) {
      const productNames = links.map((link) => `“${link.name}”`).join(', ');
      throw new AdminInputError(`No se puede eliminar esta fotografía porque la utilizan estos trabajos: ${productNames}. Retírala de sus galerías primero.`, 409);
    }

    const isRemote = isCloudinaryStorageKey(media.storage_key);
    if (isRemote) {
      try {
        const backup = await snapshotStoredImage(media.storage_key);
        if (backup) remoteBackups.push({ storageKey: media.storage_key, bytes: backup.bytes });
        await removeStoredImage(media.storage_key);
      } catch (error) {
        logMediaFailure('eliminación de imagen remota', error);
        throw error;
      }
    }

    await auditAdminAction(client, request.adminSession.id, 'media.deleted', 'media_asset', id, {
      originalFilename: media.original_filename,
    });
    await client.query('DELETE FROM media_assets WHERE id = $1', [id]);
    const { rows: remainingReferences } = await client.query(
      'SELECT 1 FROM media_assets WHERE storage_key = $1 LIMIT 1',
      [media.storage_key],
    );
    return {
      id,
      storageKey: media.storage_key,
      originalFilename: media.original_filename,
      removeFile: remainingReferences.length === 0 && !isRemote,
    };
  });
  if (result === null) {
    for (const backup of remoteBackups) {
      try { await restoreStoredImage(backup.storageKey, backup.bytes); }
      catch (error) { logMediaFailure('restauración de imagen tras rollback', error); }
    }
    return;
  }
  if (!result.removeFile) {
    return response.json({
      id: result.id,
      warning: true,
      message: `Se eliminó el registro de “${result.originalFilename}”, pero el archivo se conservó porque todavía tiene otra referencia.`,
    });
  }
  try {
    await removeStoredImage(result.storageKey);
    response.json({ id: result.id, message: `Se eliminó “${result.originalFilename}” de la biblioteca.` });
  } catch (error) {
    logMediaFailure('eliminación de imagen local', error);
    response.json({
      id: result.id,
      warning: true,
      message: `“${result.originalFilename}” salió de la biblioteca, pero no se pudo retirar su archivo de almacenamiento.`,
    });
  }
});

router.post('/media/:id/assign', async (request, response) => {
  if (!objectBody(request.body)) return response.status(400).json({ error: 'Selecciona un trabajo para la fotografía.' });
  const result = await withAdminTransaction(response, async (client) => {
    const mediaId = validatedId(request.params.id, 'La fotografía');
    const productId = validatedId(request.body.productId, 'El trabajo');
    const { rows: products } = await client.query(
      'SELECT id, name FROM products WHERE id = $1 FOR UPDATE',
      [productId],
    );
    if (!products.length) throw new AdminInputError('No se encontró el trabajo.', 404);
    const { rows: assets } = await client.query(`
      SELECT id, media_kind, classification_status
      FROM media_assets
      WHERE id = $1
      FOR UPDATE
    `, [mediaId]);
    const asset = assets[0];
    if (!asset || asset.media_kind !== 'image') throw new AdminInputError('No se encontró la fotografía.', 404);
    const { rows: existingLinks } = await client.query(
      'SELECT 1 FROM product_media WHERE product_id = $1 AND media_asset_id = $2',
      [productId, mediaId],
    );
    if (existingLinks.length) throw new AdminInputError('Esta fotografía ya pertenece a ese trabajo.', 409);

    await client.query(`
      INSERT INTO product_media (product_id, media_asset_id, sort_order, is_cover)
      SELECT $1, $2,
             COALESCE(MAX(sort_order), -1) + 1,
             NOT COALESCE(bool_or(is_cover), FALSE)
      FROM product_media
      WHERE product_id = $1
    `, [productId, mediaId]);
    await client.query(`
      UPDATE media_assets
      SET classification_status = 'assigned',
          is_public = CASE WHEN classification_status = 'pending' THEN FALSE ELSE is_public END
      WHERE id = $1
    `, [mediaId]);
    await auditAdminAction(client, request.adminSession.id, 'media.assigned.from_library', 'media_asset', mediaId, {
      productId,
      productName: products[0].name,
    });
    return { mediaId, productId, productName: products[0].name };
  });
  if (result !== null) {
    response.status(200).json({ ...result, message: `Fotografía asignada a “${result.productName}”.` });
  }
});

router.post('/media/classify', async (request, response) => {
  if (!objectBody(request.body)) return response.status(400).json({ error: 'Revisa la clasificación solicitada.' });
  const result = await withAdminTransaction(response, async (client) => {
    const mediaIds = validatedMediaIds(request.body.mediaIds);
    const isNewProduct = objectBody(request.body.newProduct);
    if (isNewProduct === Object.hasOwn(request.body, 'productId')) {
      throw new AdminInputError('Elige un producto existente o completa los datos para crear uno nuevo.');
    }

    let product;
    let created = false;
    if (isNewProduct) {
      const input = request.body.newProduct;
      const name = requiredText(input.name, 'El nombre del producto', 180);
      const slug = slugFromProductName(name);
      const description = optionalText(input.description, 'La descripción', 5000);
      const categoryId = validatedId(input.categoryId, 'La categoría');
      const { rows: categoryRows } = await client.query(
        'SELECT id FROM categories WHERE id = $1 FOR SHARE',
        [categoryId],
      );
      if (!categoryRows.length) throw new AdminInputError('Selecciona una categoría existente.');
      const { rows } = await client.query(`
        INSERT INTO products (category_id, name, slug, description, is_published)
        VALUES ($1, $2, $3, $4, FALSE)
        RETURNING id, name, slug, category_id, is_published
      `, [categoryId, name, slug, description]);
      product = rows[0];
      created = true;
      await auditAdminAction(client, request.adminSession.id, 'product.created', 'product', product.id, {
        slug,
        isPublished: false,
        source: 'photo-inbox',
      });
    } else {
      const productId = validatedId(request.body.productId, 'El producto');
      const { rows } = await client.query(
        'SELECT id, name, is_published FROM products WHERE id = $1 FOR UPDATE',
        [productId],
      );
      product = rows[0];
      if (!product) throw new AdminInputError('No se encontró el producto seleccionado.', 404);
    }

    const { rows: mediaRows } = await client.query(`
      SELECT id, classification_status
      FROM media_assets
      WHERE id = ANY($1::bigint[])
      ORDER BY id
      FOR UPDATE
    `, [mediaIds]);
    if (mediaRows.length !== mediaIds.length || mediaRows.some((media) => media.classification_status !== 'pending')) {
      throw new AdminInputError('Una o más fotografías ya no están pendientes. Actualiza la bandeja e inténtalo de nuevo.', 409);
    }
    const { rows: linkedRows } = await client.query(
      'SELECT media_asset_id FROM product_media WHERE media_asset_id = ANY($1::bigint[])',
      [mediaIds],
    );
    if (linkedRows.length) throw new AdminInputError('Una o más fotografías ya están asociadas a un producto.', 409);

    for (const [index, mediaId] of mediaIds.entries()) {
      await client.query(`
        INSERT INTO product_media (product_id, media_asset_id, sort_order, is_cover)
        VALUES ($1, $2, $3, FALSE)
      `, [product.id, mediaId, index]);
    }
    await client.query(`
      UPDATE media_assets
      SET classification_status = 'assigned', is_public = FALSE
      WHERE id = ANY($1::bigint[])
    `, [mediaIds]);
    for (const mediaId of mediaIds) {
      await auditAdminAction(client, request.adminSession.id, 'media.classified', 'media_asset', mediaId, {
        productId: product.id,
        productCreated: created,
      });
    }
    return { productId: product.id, productName: product.name, mediaIds, productCreated: created };
  });
  if (result !== null) response.status(200).json({ ...result, message: result.productCreated ? 'Producto creado como borrador y fotografías asignadas.' : 'Fotografías asignadas. Su visibilidad en la tienda sigue desactivada.' });
});

router.get('/products', async (_request, response) => {
  try {
    const mediaVisibility = await hasVerifiablePublicMediaColumns()
      ? '(ma.is_public IS TRUE)'
      : 'FALSE';
    const { rows } = await query(`
      SELECT p.id, p.category_id, p.name, p.slug, p.description, p.price, p.currency,
             p.dimensions, p.measurement_config, p.pricing_rules, p.sort_order,
             p.is_published, c.name AS category_name, c.is_active AS category_is_active,
             COALESCE(
               json_agg(json_build_object(
                 'id', ma.id,
                 'kind', ma.media_kind,
                 'originalFilename', ma.original_filename,
                 'altText', ma.alt_text,
                 'width', ma.width,
                 'height', ma.height,
                 'isCover', pm.is_cover,
                 'isPublic', ${mediaVisibility},
                 'adminUrl', CASE WHEN ma.media_kind = 'video'
                   THEN '/api/admin/products/' || p.id::text || '/video/content'
                   ELSE '/api/admin/media/' || ma.id::text || '/content'
                 END
               ) ORDER BY pm.is_cover DESC, pm.sort_order, ma.id) FILTER (WHERE ma.id IS NOT NULL),
               '[]'::json
             ) AS media
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN product_media pm ON pm.product_id = p.id
      LEFT JOIN media_assets ma ON ma.id = pm.media_asset_id
      GROUP BY p.id, c.name, c.is_active
      ORDER BY p.sort_order, p.name
    `);
    response.json({ products: rows, maxVideoFileBytes });
  } catch {
    response.status(503).json({ error: 'No fue posible cargar los trabajos.' });
  }
});

router.put('/products/:id/media', async (request, response) => {
  if (!objectBody(request.body) || !Array.isArray(request.body.mediaIds)
    || request.body.mediaIds.length > 100 || !Array.isArray(request.body.publicMediaIds)) {
    return response.status(400).json({ error: 'Revisa el orden y la visibilidad de las fotografías.' });
  }
  const result = await withAdminTransaction(response, async (client) => {
    const productId = validatedId(request.params.id, 'El producto');
    const mediaIds = request.body.mediaIds.map((id) => validatedId(id, 'La fotografía'));
    if (new Set(mediaIds).size !== mediaIds.length) throw new AdminInputError('La galería contiene fotografías repetidas.');
    const publicIds = request.body.publicMediaIds.map((id) => validatedId(id, 'La fotografía'));
    if (new Set(publicIds).size !== publicIds.length || publicIds.some((id) => !mediaIds.includes(id))) {
      throw new AdminInputError('La visibilidad solo puede configurarse para fotografías de esta galería.');
    }
    const coverId = request.body.coverMediaId === null || request.body.coverMediaId === undefined
      ? null
      : validatedId(request.body.coverMediaId, 'La portada');
    if (coverId !== null && !mediaIds.includes(coverId)) throw new AdminInputError('Elige una fotografía de esta galería como portada.');

    const { rows: productRows } = await client.query(
      'SELECT id FROM products WHERE id = $1 FOR UPDATE',
      [productId],
    );
    if (!productRows.length) throw new AdminInputError('No se encontró el producto.', 404);

    const currentIds = new Set((await client.query(
      'SELECT media_asset_id FROM product_media WHERE product_id = $1 FOR UPDATE',
      [productId],
    )).rows.map((row) => String(row.media_asset_id)));
    const lockedIds = [...new Set([...mediaIds, ...currentIds])];
    const { rows: assets } = lockedIds.length
      ? await client.query(`
        SELECT id, media_kind, classification_status, storage_key
        FROM media_assets
        WHERE id = ANY($1::bigint[])
        ORDER BY id FOR UPDATE
      `, [lockedIds])
      : { rows: [] };
    if (assets.length !== lockedIds.length) throw new AdminInputError('Una o más fotografías no están disponibles.', 404);
    const { rows: otherLinks } = mediaIds.length
      ? await client.query(`
        SELECT pm.media_asset_id
        FROM product_media pm
        WHERE pm.media_asset_id = ANY($1::bigint[])
          AND pm.product_id <> $2
          AND NOT (pm.media_asset_id = ANY($3::bigint[]))
      `, [mediaIds, productId, [...currentIds]])
      : { rows: [] };
    if (otherLinks.length) throw new AdminInputError('Una o más fotografías están asociadas a otro producto y no se pueden reutilizar desde esta galería.', 409);
    if (mediaIds.some((mediaId) => !currentIds.has(String(mediaId)))) {
      throw new AdminInputError('Asigna primero cada fotografía desde la bandeja privada. Solo puedes guardar fotos que ya pertenecen a este mueble.', 409);
    }
    if (assets.some((asset) => asset.classification_status === 'pending' && currentIds.has(String(asset.id)))) {
      throw new AdminInputError('La bandeja y la galería no coinciden. Actualiza los datos e inténtalo de nuevo.', 409);
    }
    if (assets.some((asset) => asset.classification_status === 'pending' && !currentIds.has(String(asset.id)))) {
      throw new AdminInputError('Clasifica primero las fotografías desde la bandeja.', 409);
    }

    const { rows: removedRows } = await client.query(`
      DELETE FROM product_media
      WHERE product_id = $1 AND NOT (media_asset_id = ANY($2::bigint[]))
      RETURNING media_asset_id
    `, [productId, mediaIds]);
    for (const removed of removedRows) {
      await client.query(`
        UPDATE media_assets ma
        SET classification_status = CASE WHEN EXISTS (
              SELECT 1 FROM product_media pm WHERE pm.media_asset_id = ma.id
            ) THEN 'assigned' ELSE 'pending' END,
            is_public = CASE WHEN EXISTS (
              SELECT 1 FROM product_media pm WHERE pm.media_asset_id = ma.id
            ) THEN ma.is_public ELSE FALSE END
        WHERE ma.id = $1
      `, [removed.media_asset_id]);
    }
    for (const [index, mediaId] of mediaIds.entries()) {
      await client.query(`
        INSERT INTO product_media (product_id, media_asset_id, sort_order, is_cover)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (product_id, media_asset_id)
        DO UPDATE SET sort_order = EXCLUDED.sort_order, is_cover = EXCLUDED.is_cover
      `, [productId, mediaId, index, mediaId === coverId]);
      await client.query(`
        UPDATE media_assets SET classification_status = 'assigned', is_public = $2
        WHERE id = $1
      `, [mediaId, publicIds.includes(mediaId)]);
    }
    await auditAdminAction(client, request.adminSession.id, 'product.gallery.updated', 'product', productId, {
      photoCount: mediaIds.length,
      removedAssociations: removedRows.length,
      coverMediaId: coverId,
    });
    return { productId, mediaIds, removedAssociations: removedRows.length };
  });
  if (result !== null) {
    response.json({
      productId: result.productId,
      mediaIds: result.mediaIds,
      removedAssociations: result.removedAssociations,
      message: 'Galería actualizada. Las fotografías retiradas se conservaron en la biblioteca.',
    });
  }
});

router.put('/products/:id/video', express.raw({ type: 'application/octet-stream', limit: maxVideoFileBytes, inflate: false }), async (request, response) => {
  let productId;
  try { productId = validatedId(request.params.id, 'El trabajo'); }
  catch (error) { return response.status(error.status ?? 400).json({ error: error.message }); }
  const format = validateVideoBuffer(request.body);
  if (!format || request.body.length > maxVideoFileBytes) {
    return response.status(400).json({ error: `Selecciona un video MP4 o WebM válido de hasta ${mediaSizeLabel(maxVideoFileBytes)}.` });
  }
  const originalFilename = safeOriginalFilename(request.get('X-Original-Filename'));
  let storageKey;
  try {
    storageKey = await storeVideo(request.body, format, {
      idempotencyKey: makeMediaIdempotencyKey('video', productId, randomUUID(), originalFilename, format.mimeType, request.body),
    });
  } catch (error) {
    logMediaFailure('carga de video', error);
    return response.status(503).json({ error: 'No fue posible guardar el video. Puedes volver a intentarlo.' });
  }

  let previousLocalStorageKeys = [];
  const remoteBackups = [];
  let commitAttempted = false;
  const result = await withAdminTransaction(response, async (client) => {
    const { rows: productRows } = await client.query('SELECT id FROM products WHERE id = $1 FOR UPDATE', [productId]);
    if (!productRows.length) throw new AdminInputError('No se encontró el trabajo.', 404);
    const { rows: previousRows } = await client.query(`
      SELECT ma.id, ma.storage_key
      FROM product_media pm
      JOIN media_assets ma ON ma.id = pm.media_asset_id
      WHERE pm.product_id = $1 AND ma.media_kind = 'video'
      ORDER BY pm.sort_order, ma.id
      FOR UPDATE OF ma
    `, [productId]);
    for (const previous of previousRows) {
      assertStoredMediaKeyAllowed(previous.storage_key, true);
      const { rows: otherReferences } = await client.query(
        'SELECT 1 FROM product_media WHERE media_asset_id = $1 AND product_id <> $2 LIMIT 1',
        [previous.id, productId],
      );
      if (!otherReferences.length && isCloudinaryStorageKey(previous.storage_key)) {
        try {
          const backup = await snapshotStoredVideo(previous.storage_key);
          if (backup) remoteBackups.push({ storageKey: previous.storage_key, bytes: backup.bytes });
          await removeStoredVideo(previous.storage_key);
        } catch (error) {
          logMediaFailure('reemplazo de video remoto', error);
          throw error;
        }
      }
    }
    const { rows: insertedRows } = await client.query(`
      INSERT INTO media_assets (
        storage_key, media_kind, mime_type, original_filename,
        classification_status, byte_size, is_public
      ) VALUES ($1, 'video', $2, $3, 'assigned', $4, TRUE)
      RETURNING id
    `, [storageKey, format.mimeType, originalFilename, request.body.length]);
    await client.query(`
      INSERT INTO product_media (product_id, media_asset_id, sort_order, is_cover)
      VALUES ($1, $2, COALESCE((SELECT max(sort_order) + 1 FROM product_media WHERE product_id = $1), 0), FALSE)
    `, [productId, insertedRows[0].id]);
    for (const previous of previousRows) {
      await client.query('DELETE FROM product_media WHERE product_id = $1 AND media_asset_id = $2', [productId, previous.id]);
      const { rows: removedRows } = await client.query(`
        DELETE FROM media_assets ma
        WHERE ma.id = $1 AND NOT EXISTS (
          SELECT 1 FROM product_media pm WHERE pm.media_asset_id = ma.id
        )
        RETURNING storage_key
      `, [previous.id]);
      if (removedRows[0]?.storage_key && !isCloudinaryStorageKey(removedRows[0].storage_key)) {
        previousLocalStorageKeys.push(removedRows[0].storage_key);
      }
    }
    await auditAdminAction(client, request.adminSession.id, 'product.video.updated', 'product', productId, {
      byteSize: request.body.length,
      mimeType: format.mimeType,
      replaced: previousRows.length > 0,
    });
    return { productId, mediaId: insertedRows[0].id, mimeType: format.mimeType };
  }, { onCommitAttempt: () => { commitAttempted = true; } });
  if (result === null) {
    for (const backup of remoteBackups) {
      try { await restoreStoredVideo(backup.storageKey, backup.bytes); }
      catch (error) { logMediaFailure('restauración de video tras rollback', error); }
    }
    if (!commitAttempted) {
      try { await removeStoredVideo(storageKey); }
      catch (error) { logMediaFailure('limpieza de video interrumpido', error); }
    } else {
      logMediaFailure('limpieza aplazada por resultado de confirmación incierto', { code: 'MEDIA_COMMIT_OUTCOME_UNKNOWN' });
    }
    return;
  }
  await Promise.all(previousLocalStorageKeys.map((key) => removeStoredVideo(key).catch((error) => {
    logMediaFailure('limpieza de video local', error);
  })));
  response.status(201).json({
    video: { id: result.mediaId, mimeType: result.mimeType, url: `/media/video/${result.mediaId}` },
    message: 'Video guardado y asociado al trabajo.',
  });
});

router.delete('/products/:id/video', async (request, response) => {
  const remoteBackups = [];
  const result = await withAdminTransaction(response, async (client) => {
    const productId = validatedId(request.params.id, 'El trabajo');
    const { rows: productRows } = await client.query('SELECT id FROM products WHERE id = $1 FOR UPDATE', [productId]);
    if (!productRows.length) throw new AdminInputError('No se encontró el trabajo.', 404);
    const { rows } = await client.query(`
      SELECT ma.id, ma.storage_key
      FROM product_media pm
      JOIN media_assets ma ON ma.id = pm.media_asset_id
      WHERE pm.product_id = $1 AND ma.media_kind = 'video'
      ORDER BY pm.sort_order, ma.id
      FOR UPDATE OF ma
    `, [productId]);
    if (!rows.length) throw new AdminInputError('Este trabajo no tiene un video asociado.', 404);
    const storageKeys = [];
    for (const video of rows) {
      assertStoredMediaKeyAllowed(video.storage_key, true);
      const { rows: otherReferences } = await client.query(
        'SELECT 1 FROM product_media WHERE media_asset_id = $1 AND product_id <> $2 LIMIT 1',
        [video.id, productId],
      );
      if (!otherReferences.length && isCloudinaryStorageKey(video.storage_key)) {
        try {
          const backup = await snapshotStoredVideo(video.storage_key);
          if (backup) remoteBackups.push({ storageKey: video.storage_key, bytes: backup.bytes });
          await removeStoredVideo(video.storage_key);
        } catch (error) {
          logMediaFailure('eliminación de video remoto', error);
          throw error;
        }
      }
      await client.query('DELETE FROM product_media WHERE product_id = $1 AND media_asset_id = $2', [productId, video.id]);
      const { rows: removedRows } = await client.query(`
        DELETE FROM media_assets ma
        WHERE ma.id = $1 AND NOT EXISTS (
          SELECT 1 FROM product_media pm WHERE pm.media_asset_id = ma.id
        )
        RETURNING storage_key
      `, [video.id]);
      if (removedRows[0]?.storage_key && !isCloudinaryStorageKey(removedRows[0].storage_key)) {
        storageKeys.push(removedRows[0].storage_key);
      }
    }
    await auditAdminAction(client, request.adminSession.id, 'product.video.removed', 'product', productId, {
      mediaIds: rows.map((video) => video.id),
      retainedForOtherProducts: storageKeys.length < rows.length,
    });
    return { storageKeys };
  });
  if (result === null) {
    for (const backup of remoteBackups) {
      try { await restoreStoredVideo(backup.storageKey, backup.bytes); }
      catch (error) { logMediaFailure('restauración de video tras rollback', error); }
    }
  } else {
    await Promise.all(result.storageKeys.map((key) => removeStoredVideo(key).catch((error) => {
      logMediaFailure('eliminación de video local', error);
    })));
    response.json({ message: 'Video retirado del trabajo. Las fotografías no se modificaron.' });
  }
});

router.get('/products/:id/video/content', async (request, response) => {
  let productId;
  try { productId = validatedId(request.params.id, 'El trabajo'); }
  catch (error) { return response.status(error.status ?? 400).json({ error: error.message }); }
  try {
    const { rows } = await query(`
      SELECT ma.storage_key, ma.mime_type
      FROM product_media pm
      JOIN media_assets ma ON ma.id = pm.media_asset_id
      WHERE pm.product_id = $1 AND ma.media_kind = 'video'
      ORDER BY pm.sort_order, ma.id LIMIT 1
    `, [productId]);
    if (!rows.length || !['video/mp4', 'video/webm'].includes(rows[0].mime_type)) {
      return response.status(404).json({ error: 'No se encontró el video del trabajo.' });
    }
    return streamVideo(request, response, rows[0].storage_key, rows[0].mime_type);
  } catch (error) {
    if (!response.headersSent) {
      const unavailable = error?.code && error.code !== 'ENOENT';
      response.status(unavailable ? 503 : 404).json({
        error: unavailable ? 'No fue posible recuperar el video del trabajo.' : 'No se encontró el video del trabajo.',
      });
    }
  }
});

router.post('/products', async (request, response) => {
  if (!objectBody(request.body)) return response.status(400).json({ error: 'Revisa los datos del trabajo.' });
  const result = await withAdminTransaction(response, async (client) => {
    const name = requiredText(request.body.name, 'El nombre', 180);
    const slug = validatedSlug(request.body.slug);
    const description = optionalText(request.body.description, 'La descripción', 5000);
    const category = await categoryIdFromBody(client, request.body);
    const measurementConfig = parseConfig(request.body, 'measurementConfig', validatedMeasurementConfig, 'medidas');
    const fixedDimensions = Object.hasOwn(request.body, 'fixedDimensions')
      ? validatedFixedDimensions(request.body.fixedDimensions)
      : null;
    const price = validatedProductPrice(request.body.price);
    const pricingRules = parseConfig(request.body, 'pricingRules', validatedPricingRule, 'precio');
    assertPricingFieldsConfigured(pricingRules ?? category.pricing_rules, measurementConfig);
    const { rows } = await client.query(`
      INSERT INTO products (
        category_id, name, slug, description, price, dimensions, measurement_config, pricing_rules, is_published
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, FALSE)
      RETURNING id, category_id, name, slug, description, price, currency, measurement_config,
                dimensions, pricing_rules, is_published
    `, [
      category.id,
      name,
      slug,
      description,
      price,
      fixedDimensions === null ? null : JSON.stringify(fixedDimensions),
      measurementConfig === null ? null : JSON.stringify(measurementConfig),
      pricingRules === null ? null : JSON.stringify(pricingRules),
    ]);
    const product = rows[0];
    await auditAdminAction(client, request.adminSession.id, 'product.created', 'product', product.id, {
      slug,
      isPublished: false,
      fixedDimensionCount: fixedDimensions?.dimensions.length ?? 0,
    });
    return product;
  });
  if (result !== null) response.status(201).json({ product: result, message: 'Trabajo creado como borrador.' });
});

router.patch('/products/:id', async (request, response) => {
  if (!objectBody(request.body)) return response.status(400).json({ error: 'Revisa los datos del trabajo.' });
  const result = await withAdminTransaction(response, async (client) => {
    const id = validatedId(request.params.id);
    const name = requiredText(request.body.name, 'El nombre', 180);
    const slug = validatedSlug(request.body.slug);
    const description = optionalText(request.body.description, 'La descripción', 5000);
    const category = await categoryIdFromBody(client, request.body);
    const measurementConfig = parseConfig(request.body, 'measurementConfig', validatedMeasurementConfig, 'medidas');
    const hasFixedDimensions = Object.hasOwn(request.body, 'fixedDimensions');
    const fixedDimensions = hasFixedDimensions
      ? validatedFixedDimensions(request.body.fixedDimensions)
      : null;
    const hasPrice = Object.hasOwn(request.body, 'price');
    const price = hasPrice ? validatedProductPrice(request.body.price) : null;
    const pricingRules = parseConfig(request.body, 'pricingRules', validatedPricingRule, 'precio');
    assertPricingFieldsConfigured(pricingRules ?? category.pricing_rules, measurementConfig);
    const { rows } = await client.query(`
      UPDATE products
      SET category_id = $2, name = $3, slug = $4, description = $5,
          price = CASE WHEN $6 THEN $7::numeric ELSE price END,
          dimensions = CASE WHEN $8 THEN $9::jsonb ELSE dimensions END,
          measurement_config = $10::jsonb, pricing_rules = $11::jsonb, updated_at = now()
      WHERE id = $1
      RETURNING id, category_id, name, slug, description, price, currency, measurement_config,
                dimensions, pricing_rules, is_published
    `, [
      id,
      category.id,
      name,
      slug,
      description,
      hasPrice,
      price,
      hasFixedDimensions,
      fixedDimensions === null ? null : JSON.stringify(fixedDimensions),
      measurementConfig === null ? null : JSON.stringify(measurementConfig),
      pricingRules === null ? null : JSON.stringify(pricingRules),
    ]);
    if (!rows.length) throw new AdminInputError('No se encontró el trabajo.', 404);
    await auditAdminAction(client, request.adminSession.id, 'product.updated', 'product', id, {
      slug,
      ...(hasFixedDimensions ? { fixedDimensionCount: fixedDimensions?.dimensions.length ?? 0 } : {}),
    });
    return rows[0];
  });
  if (result !== null) response.json({ product: result, message: 'Trabajo actualizado.' });
});

router.delete('/products/:id', async (request, response) => {
  const result = await withAdminTransaction(response, async (client) => {
    const id = validatedId(request.params.id, 'El trabajo');
    const { rows: productRows } = await client.query(
      'SELECT id, slug, is_published FROM products WHERE id = $1 FOR UPDATE',
      [id],
    );
    const product = productRows[0];
    if (!product) throw new AdminInputError('No se encontró el trabajo.', 404);

    const { rows: mediaRows } = await client.query(`
      SELECT ma.id AS media_asset_id
      FROM product_media pm
      JOIN media_assets ma ON ma.id = pm.media_asset_id
      WHERE pm.product_id = $1
      ORDER BY ma.id
      FOR UPDATE OF ma
    `,
      [id],
    );
    await client.query('DELETE FROM product_media WHERE product_id = $1', [id]);
    for (const media of mediaRows) {
      await client.query(`
        UPDATE media_assets ma
        SET classification_status = CASE WHEN EXISTS (
              SELECT 1 FROM product_media pm WHERE pm.media_asset_id = ma.id
            ) THEN 'assigned' ELSE 'pending' END,
            is_public = CASE WHEN EXISTS (
              SELECT 1 FROM product_media pm WHERE pm.media_asset_id = ma.id
            ) THEN ma.is_public ELSE FALSE END
        WHERE ma.id = $1
      `, [media.media_asset_id]);
    }

    try {
      const { rowCount } = await client.query('DELETE FROM products WHERE id = $1', [id]);
      if (rowCount !== 1) throw new AdminInputError('No se encontró el trabajo.', 404);
    } catch (error) {
      if (error.code === '23503') {
        throw new AdminInputError('No se puede eliminar este trabajo porque conserva otros registros asociados. No se modificó ningún dato; revisa esas dependencias antes de volver a intentarlo.', 409);
      }
      throw error;
    }

    await auditAdminAction(client, request.adminSession.id, 'product.deleted', 'product', id, {
      slug: product.slug,
      wasPublished: product.is_published,
      mediaAssociationsRemoved: mediaRows.length,
    });
    return {
      id,
      message: 'Trabajo eliminado. Sus fotografías se conservaron en la biblioteca.',
    };
  });
  if (result !== null) {
    response.json({ id: result.id, message: result.message });
  }
});

async function setProductPublication(request, response, isPublished) {
  const result = await withAdminTransaction(response, async (client) => {
    const id = validatedId(request.params.id);
    if (isPublished) {
      const { rows: productReferenceRows } = await client.query(
        'SELECT category_id FROM products WHERE id = $1',
        [id],
      );
      if (!productReferenceRows.length) throw new AdminInputError('No se encontró el trabajo.', 404);
      const categoryId = productReferenceRows[0].category_id;
      if (!categoryId) throw new AdminInputError('Asigna el trabajo a una categoría activa antes de publicarlo.');
      const { rows: categoryRows } = await client.query(
        'SELECT id, is_active, pricing_rules FROM categories WHERE id = $1 FOR UPDATE',
        [categoryId],
      );
      if (!categoryRows[0]?.is_active) {
        throw new AdminInputError('Asigna el trabajo a una categoría activa antes de publicarlo.');
      }
    }
    const { rows: existingRows } = await client.query(`
      SELECT id, category_id, measurement_config, pricing_rules
      FROM products WHERE id = $1 FOR UPDATE
    `, [id]);
    const existing = existingRows[0];
    if (!existing) throw new AdminInputError('No se encontró el trabajo.', 404);
    if (isPublished) {
      const { rows: categoryRows } = await client.query(
        'SELECT pricing_rules FROM categories WHERE id = $1',
        [existing.category_id],
      );
      if (!categoryRows.length) {
        throw new AdminInputError('Asigna el trabajo a una categoría activa antes de publicarlo.');
      }
      assertPricingFieldsConfigured(
        existing.pricing_rules ?? categoryRows[0].pricing_rules,
        existing.measurement_config,
      );
    }

    const { rows } = await client.query(`
      UPDATE products SET is_published = $2, updated_at = now()
      WHERE id = $1
      RETURNING id, name, is_published
    `, [id, isPublished]);
    await auditAdminAction(
      client,
      request.adminSession.id,
      isPublished ? 'product.published' : 'product.unpublished',
      'product',
      id,
    );
    return rows[0];
  });
  if (result !== null) response.json({ product: result, message: isPublished ? 'Trabajo publicado.' : 'Trabajo despublicado.' });
}

router.post('/products/:id/publish', (request, response) => setProductPublication(request, response, true));
router.post('/products/:id/unpublish', (request, response) => setProductPublication(request, response, false));

export default router;
