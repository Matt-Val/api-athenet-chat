import { createHash, randomBytes } from 'node:crypto';

import { config } from '../config.js';
import { query } from '../db.js';

/*
    Tickets de un solo uso: el navegador no puede mandar cabeceras en el handshake,
    asi que el token no cabe ahi. Como el ticket viaja en una URL, dura segundos,
    sirve una vez y en la base solo queda su hash.
*/

const TICKET_BYTES = 32;

// Sin sal: son 32 bytes aleatorios, no una password adivinable.
function hashTicket(rawTicket) {
  return createHash('sha256').update(rawTicket).digest('hex');
}

// Devuelve el valor crudo, lo unico que ve el cliente: en la base solo va el hash.
export async function issue(sub, displayName, target) {
  const rawTicket = randomBytes(TICKET_BYTES).toString('base64url');
  const ttlSeconds = config.ws.ticketTtlSeconds;

  // Las fechas las pone Postgres: el canje compara contra el mismo reloj.
  await query(
    `INSERT INTO ws_ticket (ticket_hash, cognito_sub, display_name, target, issued_at, expires_at)
     VALUES ($1, $2, $3, $4, now(), now() + make_interval(secs => $5))`,
    [hashTicket(rawTicket), sub, displayName, target, ttlSeconds]
  );

  return { ticket: rawTicket, expiresIn: ttlSeconds };
}

// UNA sentencia a proposito: con SELECT y despues UPDATE, dos canjes simultaneos
// leerian redeemed_at IS NULL antes de que ninguno escribiera. Asi decide Postgres.
export async function redeem(rawTicket) {
  if (typeof rawTicket !== 'string' || rawTicket === '') {
    return null;
  }

  const result = await query(
    `UPDATE ws_ticket
        SET redeemed_at = now()
      WHERE ticket_hash = $1
        AND redeemed_at IS NULL
        AND expires_at > now()
      RETURNING cognito_sub, display_name, target`,
    [hashTicket(rawTicket)]
  );

  // Cero filas = no existe, ya se uso, o expiro. Las tres son el mismo "no".
  if (result.rowCount === 0) {
    return null;
  }

  const row = result.rows[0];
  return { sub: row.cognito_sub, displayName: row.display_name, target: row.target };
}

// Se borran tambien los canjeados: el mensaje enviado ya es el registro.
const PURGE_INTERVAL_MS = 5 * 60_000;

export async function purgeExpired() {
  const result = await query('DELETE FROM ws_ticket WHERE expires_at <= now()');
  return result.rowCount;
}

export function startPurgeJob() {
  const timer = setInterval(() => {
    purgeExpired().catch((error) => {
      // Una promesa rechazada sin catch dentro de setInterval mata el proceso.
      console.error('[ticket] fallo la purga de tickets expirados:', error.message);
    });
  }, PURGE_INTERVAL_MS);

  // Sin unref, el timer pendiente impediria que el proceso termine solo.
  timer.unref();
  return timer;
}
