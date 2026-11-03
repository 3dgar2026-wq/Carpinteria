import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationDirectory = path.join(root, 'db', 'migrations');
const directConnectionString = process.env.DATABASE_URL_UNPOOLED;
const applicationConnectionString = process.env.DATABASE_URL;
const connectionString = directConnectionString || applicationConnectionString;
const args = process.argv.slice(2);
const expectedDatabase = args[1];
const backupVerified = args.includes('--backup-verified');

function isPooledConnectionString(value) {
  try {
    return /-pooler\./i.test(new URL(value).hostname);
  } catch {
    return false;
  }
}

if (args.length < 2 || args.length > 3 || args[0] !== '--database'
  || !/^[a-z_][a-z0-9_]{0,62}$/i.test(expectedDatabase ?? '')
  || (args.length === 3 && args[2] !== '--backup-verified')) {
  console.error('Uso: npm run db:migrate -- --database <nombre-exacto> [--backup-verified]');
  process.exit(1);
}

if (!connectionString) {
  console.error('Falta DATABASE_URL_UNPOOLED o DATABASE_URL. Configura el entorno antes de ejecutar migraciones.');
  process.exit(1);
}
if ((directConnectionString && isPooledConnectionString(directConnectionString))
  || (!directConnectionString && isPooledConnectionString(applicationConnectionString))) {
  console.error('Las migraciones requieren una conexión directa de Neon en DATABASE_URL_UNPOOLED.');
  process.exit(1);
}

const client = new Client({ connectionString });

try {
  await client.connect();
  const { rows: databaseRows } = await client.query('SELECT current_database() AS name, current_schema() AS schema_name');
  if (databaseRows[0]?.name !== expectedDatabase) {
    throw new Error('La conexión no apunta a la base de datos indicada.');
  }
  if (databaseRows[0]?.schema_name !== 'public') {
    throw new Error('La conexión no usa public como esquema activo.');
  }

  const { rows: customSchemas } = await client.query(`
    SELECT nspname AS name
    FROM pg_namespace
    WHERE nspname NOT IN ('public', 'pg_catalog', 'information_schema')
      AND nspname NOT LIKE 'pg_toast%'
      AND nspname NOT LIKE 'pg_temp_%'
      AND nspname NOT LIKE 'pg_toast_temp_%'
    ORDER BY nspname
  `);
  if (customSchemas.length > 0) {
    throw new Error('La base contiene esquemas no estándar; requiere revisión manual.');
  }

  const { rows: existingRelations } = await client.query(`
    SELECT c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      AND c.relname <> 'schema_migrations'
    ORDER BY c.relname
  `);
  const { rows: ledgerRows } = await client.query(`
    SELECT to_regclass('public.schema_migrations') AS name
  `);
  const hasLedger = Boolean(ledgerRows[0]?.name);
  if (!hasLedger && existingRelations.length > 0) {
    throw new Error('La base ya contiene objetos públicos sin registro de migraciones; requiere revisión manual.');
  }

  if (hasLedger) {
    const { rows: appliedRows } = await client.query('SELECT name FROM public.schema_migrations');
    const appliedNames = new Set(appliedRows.map(({ name }) => name));
    const knownFiles = new Set((await readdir(migrationDirectory))
      .filter((name) => /^\d+_[\w-]+\.sql$/.test(name)));
    if ([...appliedNames].some((name) => !knownFiles.has(name))) {
      throw new Error('El registro contiene migraciones ajenas a este proyecto.');
    }
    const hasPendingMigrations = [...knownFiles].some((name) => !appliedNames.has(name));
    if (hasPendingMigrations && !backupVerified) {
      throw new Error('La base ya registra migraciones; realiza un respaldo y vuelve a ejecutar con --backup-verified.');
    }
  }

  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationDirectory))
    .filter((name) => /^\d+_[\w-]+\.sql$/.test(name))
    .sort();

  for (const name of files) {
    const { rowCount } = await client.query('SELECT 1 FROM public.schema_migrations WHERE name = $1', [name]);
    if (rowCount) {
      console.log(`Omitida (ya aplicada): ${name}`);
      continue;
    }

    const sql = await readFile(path.join(migrationDirectory, name), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO public.schema_migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
      console.log(`Aplicada: ${name}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} catch (error) {
  console.error('No se pudieron aplicar las migraciones. Verifica el destino y el estado del esquema.');
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
