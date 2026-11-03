import { pool } from './db.js';
import { MediaStorageConfigurationError, validateMediaStorageConfiguration } from './media-storage-config.js';

if (!process.env.DATABASE_URL) {
  console.error('Falta DATABASE_URL. Copia .env.example a .env y configura PostgreSQL.');
  process.exit(1);
}

try {
  validateMediaStorageConfiguration(process.env);
} catch (error) {
  if (error instanceof MediaStorageConfigurationError) console.error(error.message);
  else console.error('No se pudo validar la configuración de almacenamiento multimedia.');
  process.exit(1);
}

let app;
try {
  ({ default: app } = await import('./app.js'));
} catch {
  console.error('No se pudo preparar la aplicación con la configuración multimedia indicada.');
  process.exit(1);
}

const portValue = process.env.PORT ?? '3000';
const port = Number(portValue);
if (!/^\d+$/.test(portValue) || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('PORT debe ser un número entre 1 y 65535.');
  process.exit(1);
}

const server = app.listen(port, '0.0.0.0', () => console.log(`Servidor disponible en http://0.0.0.0:${port}`));

function shutdown() {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
