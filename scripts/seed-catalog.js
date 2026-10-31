import pg from 'pg';

const { Client } = pg;
const expectedDatabase = 'carpinteria_db';
const args = process.argv.slice(2);

if (args.length !== 2 || args[0] !== '--database' || args[1] !== expectedDatabase) {
  console.error('Uso: npm run db:seed:catalog -- --database carpinteria_db');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('Falta DATABASE_URL. Configura el entorno antes de preparar el catálogo.');
  process.exit(1);
}

const initialEntries = [
  { name: 'Clósets a medida', slug: 'closets-a-medida', sortOrder: 10 },
  { name: 'Ventanas en madera', slug: 'ventanas-en-madera', sortOrder: 20 },
  { name: 'Puertas en madera', slug: 'puertas-en-madera', sortOrder: 30 },
  { name: 'Muebles personalizados', slug: 'muebles-personalizados', sortOrder: 40 },
];

const client = new Client({ connectionString: process.env.DATABASE_URL });
let transactionOpen = false;

try {
  await client.connect();

  const { rows: databaseRows } = await client.query('SELECT current_database() AS name');
  if (databaseRows[0]?.name !== expectedDatabase) {
    throw new Error('La conexión no apunta a la base de datos indicada.');
  }

  const { rows: schemaRows } = await client.query(`
    SELECT to_regclass('public.categories') AS categories,
           to_regclass('public.products') AS products,
           to_regclass('public.product_media') AS product_media,
           EXISTS (
             SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'products'
               AND column_name = 'measurement_config'
           ) AS has_measurement_config,
           EXISTS (
             SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'products'
               AND column_name = 'pricing_rules'
           ) AS has_product_pricing_rules
  `);
  const schema = schemaRows[0];
  if (!schema?.categories || !schema.products || !schema.product_media
    || !schema.has_measurement_config || !schema.has_product_pricing_rules) {
    throw new Error('Faltan las tablas del catálogo. Aplica las migraciones requeridas primero.');
  }

  await client.query('BEGIN');
  transactionOpen = true;

  let categoriesAdded = 0;
  let productsAdded = 0;

  for (const entry of initialEntries) {
    const categoryInsert = await client.query(`
      INSERT INTO categories (name, slug, sort_order)
      VALUES ($1, $2, $3)
      ON CONFLICT (slug) DO NOTHING
      RETURNING id
    `, [entry.name, entry.slug, entry.sortOrder]);
    categoriesAdded += categoryInsert.rowCount;

    const { rows: categoryRows } = await client.query(
      'SELECT id, name FROM categories WHERE slug = $1',
      [entry.slug],
    );
    const category = categoryRows[0];
    if (!category || category.name !== entry.name) {
      throw new Error(`La categoría ${entry.slug} ya existe con otros datos; no se modificó.`);
    }

    const productInsert = await client.query(`
      INSERT INTO products (
        category_id, name, slug, description, price, dimensions,
        measurement_config, pricing_rules, is_published, sort_order
      )
      VALUES ($1, $2, $3, NULL, NULL, NULL, NULL, NULL, FALSE, $4)
      ON CONFLICT (slug) DO NOTHING
      RETURNING id
    `, [category.id, entry.name, entry.slug, entry.sortOrder]);
    productsAdded += productInsert.rowCount;

    if (productInsert.rowCount === 0) {
      const { rows: existingRows } = await client.query(`
        SELECT p.id, p.category_id, p.name, p.description, p.price,
               p.dimensions, p.measurement_config, p.pricing_rules,
               p.is_published,
               EXISTS (
                 SELECT 1 FROM product_media pm WHERE pm.product_id = p.id
               ) AS has_media
        FROM products p
        WHERE p.slug = $1
      `, [entry.slug]);
      const existing = existingRows[0];
      const isSameEmptyDraft = existing
        && String(existing.category_id) === String(category.id)
        && existing.name === entry.name
        && existing.description === null
        && existing.price === null
        && existing.dimensions === null
        && existing.measurement_config === null
        && existing.pricing_rules === null
        && existing.is_published === false
        && existing.has_media === false;

      if (!isSameEmptyDraft) {
        throw new Error(`El trabajo ${entry.slug} ya existe con otros datos; no se modificó.`);
      }
    }
  }

  await client.query('COMMIT');
  transactionOpen = false;
  console.log(`Preparación terminada en ${expectedDatabase}: ${categoriesAdded} categorías y ${productsAdded} borradores nuevos.`);
  console.log('Los borradores no se publicaron y no incluyen descripciones, precios, medidas, reglas ni fotografías.');
} catch {
  if (transactionOpen) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('No se pudo preparar el catálogo; la transacción se revirtió y no se publicó ningún producto.');
  } else {
    console.error('No se pudo preparar el catálogo; no se modificó la base de datos.');
  }
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
