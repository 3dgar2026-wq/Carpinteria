import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query as defaultQuery } from './db.js';
import { calculateConfiguredEstimate, InvalidMeasurementError } from './pricing.js';
import { normalizeFixedDimensions } from './fixed-dimensions.js';
import * as defaultMediaStorage from './media-storage.js';
import { hasVerifiablePublicMediaColumns } from './media-schema.js';
import defaultAdminApiRouter from './admin-api.js';
import { createAdminPageRouter } from './admin-auth.js';

const publicDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp({
  query = defaultQuery,
  mediaStorage = defaultMediaStorage,
  adminApiRouter = defaultAdminApiRouter,
  adminPageRouter,
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  // Public and private Render traffic share this listener. Keep forwarded
  // headers untrusted; the authentication limiters use stable HMAC buckets.
  app.set('trust proxy', false);
  app.use((request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
    next();
  });

    app.use(express.json({ limit: '32kb', inflate: false }));
    app.use(express.urlencoded({ extended: false, limit: '8kb', inflate: false }));

  app.get('/api/health', async (_request, response) => {
    try {
      await query('SELECT 1');
      response.json({ status: 'ok' });
    } catch {
      response.status(503).json({ status: 'unavailable' });
    }
  });

  app.get('/api/catalog', async (_request, response) => {
    response.set('Cache-Control', 'no-store');
    try {
      const canVerifyMedia = await hasVerifiablePublicMediaColumns(query);
      const mediaSelection = canVerifyMedia ? `
        COALESCE((
          SELECT json_agg(json_build_object(
            'id', visible.id,
            'altText', visible.alt_text,
            'isCover', visible.is_cover,
            'url', '/media/' || visible.id::text
          ) ORDER BY visible.is_cover DESC, visible.sort_order, visible.id)
          FROM (
            SELECT ma.id, ma.alt_text, pm.is_cover, pm.sort_order
            FROM product_media pm
            JOIN media_assets ma ON ma.id = pm.media_asset_id
            WHERE pm.product_id = p.id
              AND ma.media_kind = 'image'
              AND ma.classification_status = 'assigned'
              AND ma.is_public IS TRUE
            ORDER BY pm.is_cover DESC, pm.sort_order, ma.id
            LIMIT 8
          ) AS visible
        ), '[]'::json) AS media
      ` : "'[]'::json AS media";
      const videosSelection = canVerifyMedia ? `COALESCE((
        SELECT json_agg(json_build_object(
          'id', visible_video.id,
          'mimeType', visible_video.mime_type,
          'url', '/media/video/' || visible_video.id::text
        ) ORDER BY visible_video.sort_order, visible_video.id)
        FROM (
          SELECT ma.id, ma.mime_type, pm.sort_order
          FROM product_media pm
          JOIN media_assets ma ON ma.id = pm.media_asset_id
          WHERE pm.product_id = p.id
            AND ma.media_kind = 'video'
            AND ma.classification_status = 'assigned'
            AND ma.is_public IS TRUE
          ORDER BY pm.sort_order, ma.id
          LIMIT 8
        ) AS visible_video
      ), '[]'::json) AS videos` : "'[]'::json AS videos";
      const videoSelection = canVerifyMedia ? `(
        SELECT json_build_object(
          'id', visible_video.id,
          'mimeType', visible_video.mime_type,
          'url', '/media/video/' || visible_video.id::text
        )
        FROM product_media pm
        JOIN media_assets visible_video ON visible_video.id = pm.media_asset_id
        WHERE pm.product_id = p.id
          AND visible_video.media_kind = 'video'
          AND visible_video.classification_status = 'assigned'
          AND visible_video.is_public IS TRUE
        ORDER BY pm.sort_order, visible_video.id
        LIMIT 1
      ) AS video` : 'NULL::json AS video';
      const { rows } = await query(`
        SELECT p.id, p.name, p.slug, p.description, p.price, p.currency,
               p.measurement_config, p.dimensions,
               c.name AS category_name, c.slug AS category_slug,
               ${mediaSelection}, ${videosSelection}, ${videoSelection}
        FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.is_published = TRUE
        ORDER BY p.sort_order, p.name, p.id
      `);
      response.json({
        products: rows.map(({ dimensions, ...product }) => ({
          ...product,
          fixed_dimensions: normalizeFixedDimensions(dimensions),
        })),
      });
    } catch {
      response.status(503).json({ error: 'No fue posible consultar el catálogo.' });
    }
  });

  app.get('/media/:id', async (request, response) => {
    const id = request.params.id;
    if (!/^[1-9]\d{0,18}$/.test(id) || (id.length === 19 && id > '9223372036854775807')) {
      return response.status(404).send('No se encontró la fotografía.');
    }
    let rows;
    try {
      if (!(await hasVerifiablePublicMediaColumns(query))) {
        return response.status(404).send('No se encontró la fotografía.');
      }
      ({ rows } = await query(`
        SELECT ma.storage_key, ma.mime_type
        FROM media_assets ma
        WHERE ma.id = $1 AND ma.media_kind = 'image'
          AND ma.classification_status = 'assigned'
          AND ma.is_public IS TRUE
          AND EXISTS (
            SELECT 1 FROM product_media pm
            JOIN products p ON p.id = pm.product_id
            WHERE pm.media_asset_id = ma.id AND p.is_published = TRUE
          )
      `, [id]));
    } catch {
      return response.status(503).send('No fue posible verificar la fotografía.');
    }
    if (!rows.length || !['image/jpeg', 'image/png', 'image/webp'].includes(rows[0].mime_type)) {
      return response.status(404).send('No se encontró la fotografía.');
    }
    try {
      response.set({
        'Content-Type': rows[0].mime_type,
        'Content-Disposition': 'inline',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      const stream = await mediaStorage.openStoredImage(rows[0].storage_key);
      stream.on('error', () => {
        if (!response.headersSent) response.status(404).send('No se encontró la fotografía.');
        else response.destroy();
      });
      stream.pipe(response);
    } catch {
      if (!response.headersSent) response.status(503).send('No fue posible recuperar la fotografía.');
    }
  });

  app.get('/media/video/:id', async (request, response) => {
    const id = request.params.id;
    if (!/^[1-9]\d{0,18}$/.test(id) || (id.length === 19 && id > '9223372036854775807')) {
      return response.status(404).send('No se encontró el video.');
    }
    let rows;
    try {
      if (!(await hasVerifiablePublicMediaColumns(query))) return response.status(404).send('No se encontró el video.');
      ({ rows } = await query(`
        SELECT ma.storage_key, ma.mime_type
        FROM media_assets ma
        WHERE ma.id = $1 AND ma.media_kind = 'video'
          AND ma.classification_status = 'assigned' AND ma.is_public IS TRUE
          AND EXISTS (
            SELECT 1 FROM product_media pm
            JOIN products p ON p.id = pm.product_id
            WHERE pm.media_asset_id = ma.id AND p.is_published = TRUE
          )
      `, [id]));
    } catch {
      return response.status(503).send('No fue posible verificar el video.');
    }
    if (!rows.length || !['video/mp4', 'video/webm'].includes(rows[0].mime_type)) {
      return response.status(404).send('No se encontró el video.');
    }
    try {
      const size = await mediaStorage.getStoredVideoSize(rows[0].storage_key);
      let range = null;
      const header = request.get('Range');
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
      const { stream } = await mediaStorage.openStoredVideo(rows[0].storage_key, range ?? undefined);
      response.set({
        'Content-Type': rows[0].mime_type,
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
    } catch {
      if (!response.headersSent) response.status(503).send('No fue posible recuperar el video.');
    }
  });

  app.post('/api/catalog/:id/estimate', async (request, response) => {
    const { id } = request.params;
    const maxId = '9223372036854775807';
    if (!/^[1-9]\d{0,18}$/.test(id) || (id.length === 19 && id > maxId)) {
      return response.status(400).json({ error: 'El trabajo indicado no es válido.' });
    }

    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || !body.measurements || typeof body.measurements !== 'object' || Array.isArray(body.measurements)) {
      return response.status(400).json({ error: 'Revisa las medidas enviadas.' });
    }

    try {
      const { rows } = await query(`
        SELECT p.measurement_config, p.pricing_rules,
               c.pricing_rules AS category_pricing_rules
        FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.id = $1 AND p.is_published = TRUE
      `, [id]);

      if (!rows.length) return response.status(404).json({ error: 'No se encontró el trabajo publicado.' });

      const product = rows[0];
      const result = calculateConfiguredEstimate({
        measurementConfig: product.measurement_config,
        pricingRule: product.pricing_rules ?? product.category_pricing_rules,
        measurements: body.measurements,
      });
      response.json(result);
    } catch (error) {
      if (error instanceof InvalidMeasurementError) {
        return response.status(422).json({ error: 'Revisa las medidas y los límites indicados.' });
      }
      response.status(503).json({ error: 'No fue posible calcular el precio en este momento.' });
    }
  });

    app.use('/admin', adminPageRouter ?? createAdminPageRouter());
    app.use('/api/admin', adminApiRouter);
    app.use(express.static(publicDirectory, { extensions: ['html'] }));

    app.use((error, _request, response, next) => {
    if (error.type === 'entity.parse.failed') {
      return response.status(400).json({ error: 'El cuerpo de la solicitud no contiene datos válidos.' });
    }
    if (error.type === 'entity.too.large') {
      return response.status(413).json({ error: 'La solicitud supera el tamaño permitido.' });
    }
    if (error.type === 'encoding.unsupported') {
      return response.status(415).json({ error: 'La codificación del cuerpo no está admitida.' });
    }
    console.error('Error no controlado en la solicitud.');
    if (response.headersSent) return next(error);
    response.status(500).json({ error: 'Ocurrió un error interno.' });
    });

  return app;
}

const app = createApp();
export default app;
