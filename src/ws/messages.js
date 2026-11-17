import { randomUUID } from 'node:crypto';

import { query } from '../db.js';

// La difusion es en memoria, asi que esta tabla es lo unico que sobrevive a un
// reinicio: sin ella, quien recarga la pagina entra a una sala vacia.
export const MAX_BODY_LENGTH = 500;
const HISTORY_SIZE = 50;

// MATCH-7 -> MATCH. Se deduce para no confiar en que el cliente lo mande.
function roomTypeOf(roomId) {
  return roomId.split('-')[0];
}

export async function save({ roomId, authorSub, authorDisplayName, body, sentAt }) {
  const messageId = randomUUID();

  // ON CONFLICT: hoy el id no puede repetirse, pero deja la escritura idempotente
  // si algun dia los mensajes llegan por un bus que reentrega.
  await query(
    `INSERT INTO chat_message
       (message_id, room_id, room_type, author_sub, author_display_name, body, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (message_id) DO NOTHING`,
    [messageId, roomId, roomTypeOf(roomId), authorSub, authorDisplayName, body, sentAt]
  );

  return { messageId, roomId, authorSub, authorDisplayName, body, sentAt };
}

// DESC y se invierte en memoria: ASC obligaria a leer la sala entera para
// quedarse con el final; DESC recorre el indice (room_id, sent_at DESC) y para.
export async function recentHistory(roomId, limit = HISTORY_SIZE) {
  const result = await query(
    `SELECT message_id, room_id, author_sub, author_display_name, body, sent_at
       FROM chat_message
      WHERE room_id = $1
      ORDER BY sent_at DESC
      LIMIT $2`,
    [roomId, limit]
  );

  return result.rows
    .map((row) => ({
      messageId: row.message_id,
      roomId: row.room_id,
      authorSub: row.author_sub,
      authorDisplayName: row.author_display_name,
      body: row.body,
      sentAt: row.sent_at.toISOString(),
    }))
    .reverse();
}
