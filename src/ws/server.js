import { WebSocketServer } from 'ws';

import { redeem } from '../auth/ticket.js';
import { config } from '../config.js';
import { MAX_BODY_LENGTH, recentHistory, save } from './messages.js';
import * as registry from './registry.js';

// noServer:true y enganche a mano al 'upgrade': es la unica forma de rechazar con
// un 401 de verdad. Si la libreria completara el handshake, el socket ya existiria.
const RATE_LIMIT_MESSAGES = 5;
const RATE_LIMIT_WINDOW_MS = 10_000;
const MAX_SESSIONS_PER_USER = 3;
const HEARTBEAT_MS = 30_000;
const PENDING_BUFFER_LIMIT = 100;

export function attachWebSocketServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    handleUpgrade(wss, request, socket, head).catch((error) => {
      console.error('[ws] fallo el handshake:', error.message);
      reject(socket, 500, 'Internal Server Error');
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      // No contesto el ping anterior: esta muerto aunque el socket siga
      // "abierto". Una desconexion de red no siempre cierra el TCP.
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return wss;
}

// HTTP a mano: en un upgrade todavia no existe el response de express.
function reject(socket, status, reason) {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

async function handleUpgrade(wss, request, socket, head) {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (url.pathname !== '/ws/chat') {
    return reject(socket, 404, 'Not Found');
  }

  // Si no viene Origin se permite: no hay navegador. La seguridad real la da el
  // ticket; esto solo impide que otra web embeba nuestro chat.
  const origin = request.headers.origin;
  if (origin && !config.ws.allowedOrigins.includes(origin)) {
    console.warn('[ws] origen rechazado:', origin);
    return reject(socket, 403, 'Forbidden');
  }

  const ticket = url.searchParams.get('ticket');
  const roomId = url.searchParams.get('roomId');

  if (!ticket || !roomId) {
    return reject(socket, 400, 'Bad Request');
  }

  // Primera puerta que toca la base: va al final para que una peticion basura no
  // gaste una conexion de Postgres.
  const redeemed = await redeem(ticket);
  if (!redeemed) {
    // No existe, ya se uso o expiro: las tres son lo mismo para el cliente.
    return reject(socket, 401, 'Unauthorized');
  }

  // Sin esto, un ticket pedido para MATCH-1 abriria MATCH-2.
  if (redeemed.target !== roomId) {
    console.warn('[ws] ticket de %s usado para %s', redeemed.target, roomId);
    return reject(socket, 403, 'Forbidden');
  }

  if (registry.countSessionsOf(redeemed.sub) >= MAX_SESSIONS_PER_USER) {
    return reject(socket, 429, 'Too Many Requests');
  }

  wss.handleUpgrade(request, socket, head, (socketClient) => {
    openSession(socketClient, { sub: redeemed.sub, displayName: redeemed.displayName, roomId });
  });
}

function openSession(socketClient, { sub, displayName, roomId }) {
  socketClient.isAlive = true;
  socketClient.on('pong', () => {
    socketClient.isAlive = true;
  });

  const session = {
    sub,
    displayName,
    roomId,
    timestamps: [],
    historySent: false,
    pending: [],
    send(frame) {
      if (socketClient.readyState !== socketClient.OPEN) {
        return false;
      }
      // Hasta que salga el historial, lo nuevo se encola: si se enviara de
      // inmediato, el cliente lo veria ANTES del historial y quedaria desordenado.
      if (!session.historySent) {
        if (session.pending.length >= PENDING_BUFFER_LIMIT) {
          socketClient.close(1011, 'buffer desbordado');
          return false;
        }
        session.pending.push(frame);
        return true;
      }
      socketClient.send(frame);
      return true;
    },
  };

  // ANTES de leer el historial: al reves, un mensaje que llegue durante la
  // consulta no lo recibiria nadie.
  registry.add(session);

  socketClient.on('message', (raw) => {
    handleClientMessage(session, socketClient, raw).catch((error) => {
      console.error('[ws] error procesando un mensaje:', error.message);
      sendError(socketClient, 500, 'No se pudo procesar el mensaje.');
    });
  });

  socketClient.on('close', () => registry.remove(session));
  socketClient.on('error', () => registry.remove(session));

  sendHistory(session, socketClient).catch((error) => {
    console.error('[ws] fallo el historial:', error.message);
    socketClient.close(1011, 'no se pudo cargar el historial');
  });
}

async function sendHistory(session, socketClient) {
  const messages = await recentHistory(session.roomId);

  if (socketClient.readyState !== socketClient.OPEN) {
    return;
  }

  socketClient.send(
    JSON.stringify({
      type: 'chat.ready',
      roomId: session.roomId,
      you: { sub: session.sub, displayName: session.displayName },
    })
  );
  socketClient.send(JSON.stringify({ type: 'chat.history', roomId: session.roomId, messages }));

  session.historySent = true;
  for (const frame of session.pending) {
    socketClient.send(frame);
  }
  session.pending = [];
}

async function handleClientMessage(session, socketClient, raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw.toString());
  } catch {
    return sendError(socketClient, 400, 'El marco no es JSON valido.');
  }

  if (parsed?.type === 'ping') {
    return socketClient.send(JSON.stringify({ type: 'pong' }));
  }

  if (parsed?.type !== 'chat.send') {
    return sendError(socketClient, 400, `Tipo de marco desconocido: ${parsed?.type}`);
  }

  const body = typeof parsed.body === 'string' ? parsed.body.trim() : '';
  if (body === '') {
    return sendError(socketClient, 400, 'El mensaje viene vacio.');
  }
  if (body.length > MAX_BODY_LENGTH) {
    return sendError(socketClient, 400, `El mensaje supera los ${MAX_BODY_LENGTH} caracteres.`);
  }

  if (!allowedByRateLimit(session)) {
    return sendError(socketClient, 429, 'Demasiados mensajes, espera unos segundos.');
  }

  // El autor y la hora los pone el servidor SIEMPRE: del cliente solo se toma el
  // texto. clientMessageId vuelve tal cual para que reconcilie su burbuja, y no
  // se persiste.
  const saved = await save({
    roomId: session.roomId,
    authorSub: session.sub,
    authorDisplayName: session.displayName,
    body,
    sentAt: new Date().toISOString(),
  });

  registry.broadcast(session.roomId, {
    type: 'chat.message',
    clientMessageId: typeof parsed.clientMessageId === 'string' ? parsed.clientMessageId : null,
    data: saved,
  });
}

// Ventana deslizante: un contador que se reinicia cada 10s permitiria 5 al final
// de una ventana y 5 al principio de la siguiente, o sea 10 casi seguidos.
function allowedByRateLimit(session) {
  const now = Date.now();
  session.timestamps = session.timestamps.filter((at) => now - at < RATE_LIMIT_WINDOW_MS);

  if (session.timestamps.length >= RATE_LIMIT_MESSAGES) {
    return false;
  }

  session.timestamps.push(now);
  return true;
}

function sendError(socketClient, status, message) {
  if (socketClient.readyState === socketClient.OPEN) {
    socketClient.send(JSON.stringify({ type: 'error', status, message }));
  }
}
