import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool.on('error', () => {
  console.error('Error inesperado en una conexión inactiva a PostgreSQL.');
});

export async function query(text, values = []) {
  return pool.query(text, values);
}
