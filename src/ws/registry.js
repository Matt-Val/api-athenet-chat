/*
    LIMITACION CONOCIDA: al vivir en memoria solo funciona con UNA instancia. Con
    dos, los conectados a instancias distintas no se verian entre si; escalar
    exigiria un bus. Decision consciente: el chat es un agregado opcional.
*/
const rooms = new Map();

export function add(session) {
  let room = rooms.get(session.roomId);
  if (!room) {
    room = new Set();
    rooms.set(session.roomId, room);
  }
  room.add(session);
}

export function remove(session) {
  const room = rooms.get(session.roomId);
  if (!room) {
    return;
  }
  room.delete(session);
  // Sin esto el Map acumula una entrada vacia por cada sala que existio.
  if (room.size === 0) {
    rooms.delete(session.roomId);
  }
}

export function countInRoom(roomId) {
  return rooms.get(roomId)?.size ?? 0;
}

export function countSessionsOf(sub) {
  let total = 0;
  for (const room of rooms.values()) {
    for (const session of room) {
      if (session.sub === sub) {
        total += 1;
      }
    }
  }
  return total;
}

// Incluye al emisor a proposito: asi todos pintan el mismo registro. Si cada uno
// pintara su version local, un reloj desfasado bastaria para desordenarlos.
export function broadcast(roomId, payload) {
  const room = rooms.get(roomId);
  if (!room) {
    return 0;
  }

  const frame = JSON.stringify(payload);
  let delivered = 0;

  for (const session of room) {
    if (session.send(frame)) {
      delivered += 1;
    }
  }

  return delivered;
}
