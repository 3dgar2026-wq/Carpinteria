import { query as defaultQuery } from './db.js';

export async function hasVerifiablePublicMediaColumns(query = defaultQuery) {
  const { rows } = await query(`
    SELECT count(*)::integer AS available
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'media_assets'
      AND column_name = ANY($1::text[])
  `, [['classification_status', 'is_public']]);
  return rows[0]?.available === 2;
}
