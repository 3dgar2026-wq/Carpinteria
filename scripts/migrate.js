import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationDirectory = path.join(root, 'db', 'migrations');
const connectionString = process.env.DATABASE_URL;
const expectedDatabase = 'carpinteria_db';
const args = process.argv.slice(2);

if (args.length !== 2 || args[0] !== '--database' || args[1] !== expectedDatabase) {
  console.error('Uso: npm run db:migrate -- --database carpinteria_db');
  process.exit(1);
}

if (!connectionString) {
  console.error('Falta DATABASE_URL. Configura el entorno antes de ejecutar migraciones.');
  process.exit(1);
}

const client = new Client({ connectionString });

try {
  await client.connect();
  const { rows: databaseRows } = await client.query('SELECT current_database() AS name');
  if (databaseRows[0]?.name !== expectedDatabase) {
    throw new Error('La conexión no apunta a la base de datos indicada.');
  }
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationDirectory))
    .filter((name) => /^\d+_[\w-]+\.sql$/.test(name))
    .sort();

  for (const name of files) {
    const { rowCount } = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
    if (rowCount) {
      console.log(`Omitida (ya aplicada): ${name}`);
      continue;
    }

    const sql = await readFile(path.join(migrationDirectory, name), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
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
