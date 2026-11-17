import pg from 'pg';

import { config } from './config.js';

// pg conecta de forma perezosa: crear el Pool aqui no toca la base todavia, y
// el servicio puede responder /health aunque Postgres no este listo.
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// Un error en una conexion ociosa (Postgres reiniciado) llega como evento del
// Pool. Sin este listener, Node lo trata como excepcion no capturada y muere.
pool.on('error', (error) => {
  console.error('[db] error en una conexion ociosa del pool:', error.message);
});

// SIEMPRE con parametros ($1, $2...): nunca se interpola un valor en el SQL.
export async function query(text, params = []) {
  return pool.query(text, params);
}

export async function closePool() {
  await pool.end();
}
