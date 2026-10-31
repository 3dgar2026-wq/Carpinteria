import app from './app.js';
import { pool } from './db.js';

if (!process.env.DATABASE_URL) {
  console.error('Falta DATABASE_URL. Copia .env.example a .env y configura PostgreSQL.');
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
