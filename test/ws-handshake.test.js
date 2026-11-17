import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import { WebSocket } from 'ws';

import { issue } from '../src/auth/ticket.js';
import { closePool, query } from '../src/db.js';
import * as registry from '../src/ws/registry.js';
import { attachWebSocketServer } from '../src/ws/server.js';

/*
    Test de integracion del handshake del WebSocket.

    Corre contra el Postgres de docker-compose, no contra un doble: lo que se
    prueba aqui es justamente el canje atomico del ticket, y un mock del UPDATE
    condicional probaria el mock y no la garantia.

    No se necesita Cognito: los tickets se emiten llamando a issue() directo, que
    es exactamente lo que hace la ruta POST /api/ws/ticket despues de validar el
    token. La frontera que se ejercita es ticket -> socket, no token -> ticket.
*/

const ROOM = 'MATCH-9001';
const OTHER_ROOM = 'MATCH-9002';
const SUB = '00000000-0000-0000-0000-000000009001';
const DISPLAY_NAME = 'Tester Athenet';
const ORIGIN = 'http://localhost:5173';

let httpServer;
let baseUrl;
const openSockets = new Set();

before(async () => {
  httpServer = createServer();
  attachWebSocketServer(httpServer);

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  baseUrl = `ws://127.0.0.1:${httpServer.address().port}`;
});

after(async () => {
  for (const socket of openSockets) {
    socket.terminate();
  }
  await new Promise((resolve) => httpServer.close(resolve));
  await cleanUp();
  await closePool();
});

beforeEach(cleanUp);

/*
    Cerrar las sesiones entre tests no es cosmetico: el registro de salas vive en
    memoria del modulo y el tope es de 3 sesiones por usuario, asi que un test
    que deja sockets abiertos hace que el siguiente reciba 429 y falle por una
    razon que no tiene nada que ver con lo que estaba probando.
*/
afterEach(async () => {
  const subs = new Set();
  for (const socket of openSockets) {
    subs.add(socket.testSub);
    socket.close();
  }
  openSockets.clear();

  // El registro se limpia en el 'close' del socket del SERVIDOR, que ocurre un
  // instante despues del cierre del cliente: hay que esperarlo, no suponerlo.
  const started = Date.now();
  while ([...subs].some((sub) => registry.countSessionsOf(sub) > 0)) {
    if (Date.now() - started > 2000) {
      throw new Error('El registro de sesiones no se vacio despues de cerrar los sockets.');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
});

async function cleanUp() {
  await query('DELETE FROM chat_message WHERE room_id = ANY($1)', [[ROOM, OTHER_ROOM]]);
  await query('DELETE FROM ws_ticket WHERE cognito_sub = $1', [SUB]);
}

/*
    Intenta el upgrade y resuelve con el codigo HTTP si fue rechazado, o con el
    socket ya abierto si fue aceptado. Un rechazo en un upgrade NO llega como
    error de red: llega como 'unexpected-response', que es precisamente lo que
    permite afirmar "devolvio 401" en vez de "no conecto".
*/
function attemptUpgrade(path, { origin = ORIGIN, sub = SUB } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${baseUrl}${path}`, {
      headers: origin ? { Origin: origin } : {},
    });

    const frames = [];
    socket.on('message', (raw) => frames.push(JSON.parse(raw.toString())));

    socket.on('unexpected-response', (_request, response) => {
      socket.terminate();
      resolve({ status: response.statusCode, socket: null, frames });
    });

    socket.on('open', () => {
      socket.testSub = sub;
      openSockets.add(socket);
      resolve({ status: 101, socket, frames });
    });

    // Si el servidor destruye el socket sin responder, esto evita que el test
    // quede colgado hasta el timeout global del runner.
    socket.on('error', (error) => {
      if (socket.readyState === WebSocket.CONNECTING) {
        reject(error);
      }
    });
  });
}

function send(socket, frame) {
  socket.send(JSON.stringify(frame));
}

// Espera hasta que la condicion se cumpla sobre los marcos acumulados. Sin esto
// habria que dormir un tiempo fijo, y un test que duerme es un test que falla
// en una maquina lenta.
function waitFor(frames, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = setInterval(() => {
      const found = frames.find(predicate);
      if (found) {
        clearInterval(tick);
        return resolve(found);
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(tick);
        reject(new Error(`No llego el marco esperado. Recibidos: ${JSON.stringify(frames)}`));
      }
    }, 20);
  });
}

async function openRoom(room = ROOM, { sub = SUB, origin = ORIGIN } = {}) {
  const { ticket } = await issue(sub, DISPLAY_NAME, room);
  const result = await attemptUpgrade(`/ws/chat?ticket=${ticket}&roomId=${room}`, { origin, sub });
  assert.equal(result.status, 101);
  await waitFor(result.frames, (frame) => frame.type === 'chat.history');
  return result;
}

describe('rechazos del handshake', () => {
  it('404 si la ruta no es /ws/chat', async () => {
    const { status } = await attemptUpgrade('/ws/otra-cosa?ticket=x&roomId=GLOBAL');
    assert.equal(status, 404);
  });

  it('400 si falta el ticket o la sala', async () => {
    assert.equal((await attemptUpgrade(`/ws/chat?roomId=${ROOM}`)).status, 400);
    assert.equal((await attemptUpgrade('/ws/chat?ticket=abc')).status, 400);
  });

  it('401 con un ticket inexistente', async () => {
    const { status } = await attemptUpgrade(`/ws/chat?ticket=no-existe&roomId=${ROOM}`);
    assert.equal(status, 401);
  });

  it('403 con un origen fuera de la lista blanca', async () => {
    const { ticket } = await issue(SUB, DISPLAY_NAME, ROOM);
    const { status } = await attemptUpgrade(`/ws/chat?ticket=${ticket}&roomId=${ROOM}`, {
      origin: 'http://sitio-ajeno.example',
    });
    assert.equal(status, 403);
  });

  // La razon de existir de la columna ws_ticket.target.
  it('403 si el ticket se emitio para otra sala', async () => {
    const { ticket } = await issue(SUB, DISPLAY_NAME, ROOM);
    const { status } = await attemptUpgrade(`/ws/chat?ticket=${ticket}&roomId=${OTHER_ROOM}`);
    assert.equal(status, 403);
  });

  it('el ticket sirve UNA sola vez', async () => {
    const { ticket } = await issue(SUB, DISPLAY_NAME, ROOM);

    const first = await attemptUpgrade(`/ws/chat?ticket=${ticket}&roomId=${ROOM}`);
    assert.equal(first.status, 101);

    const second = await attemptUpgrade(`/ws/chat?ticket=${ticket}&roomId=${ROOM}`);
    assert.equal(second.status, 401);
  });

  it('401 con un ticket vencido', async () => {
    const { ticket } = await issue(SUB, DISPLAY_NAME, ROOM);
    // Se envejece la fila en la base en vez de esperar el TTL real: el canje
    // compara contra now() de Postgres, asi que mover expires_at es equivalente.
    await query(
      `UPDATE ws_ticket SET expires_at = now() - interval '1 second' WHERE cognito_sub = $1`,
      [SUB]
    );

    const { status } = await attemptUpgrade(`/ws/chat?ticket=${ticket}&roomId=${ROOM}`);
    assert.equal(status, 401);
  });

  it('429 al pasar el tope de sesiones por usuario', async () => {
    const sub = '00000000-0000-0000-0000-000000009099';
    for (let i = 0; i < 3; i += 1) {
      await openRoom(ROOM, { sub });
    }

    const { ticket } = await issue(sub, DISPLAY_NAME, ROOM);
    const { status } = await attemptUpgrade(`/ws/chat?ticket=${ticket}&roomId=${ROOM}`);
    assert.equal(status, 429);
  });
});

describe('sesion abierta', () => {
  it('entrega chat.ready con la identidad del ticket y luego el historial', async () => {
    const { frames } = await openRoom();

    const ready = await waitFor(frames, (frame) => frame.type === 'chat.ready');
    assert.equal(ready.roomId, ROOM);
    assert.equal(ready.you.sub, SUB);
    assert.equal(ready.you.displayName, DISPLAY_NAME);

    const history = await waitFor(frames, (frame) => frame.type === 'chat.history');
    assert.deepEqual(history.messages, []);
    // El orden importa: chat.ready SIEMPRE antes que chat.history.
    assert.ok(frames.indexOf(ready) < frames.indexOf(history));
  });

  it('difunde el mensaje a la sala y lo persiste con autor del servidor', async () => {
    const emisor = await openRoom();
    const receptor = await openRoom(ROOM, { sub: '00000000-0000-0000-0000-000000009002' });

    send(emisor.socket, {
      type: 'chat.send',
      clientMessageId: 'cli-1',
      // El autor que manda el cliente debe ser ignorado por completo.
      authorDisplayName: 'Suplantador',
      body: 'hola sala',
    });

    const recibido = await waitFor(receptor.frames, (frame) => frame.type === 'chat.message');
    assert.equal(recibido.data.body, 'hola sala');
    assert.equal(recibido.data.authorSub, SUB);
    assert.equal(recibido.data.authorDisplayName, DISPLAY_NAME);

    // El emisor tambien lo recibe, con su clientMessageId para reconciliar.
    const eco = await waitFor(emisor.frames, (frame) => frame.type === 'chat.message');
    assert.equal(eco.clientMessageId, 'cli-1');

    const { rows } = await query(
      'SELECT author_sub, author_display_name, body FROM chat_message WHERE room_id = $1',
      [ROOM]
    );
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      author_sub: SUB,
      author_display_name: DISPLAY_NAME,
      body: 'hola sala',
    });
  });

  it('no filtra mensajes a otra sala', async () => {
    const dentro = await openRoom(ROOM);
    const fuera = await openRoom(OTHER_ROOM, { sub: '00000000-0000-0000-0000-000000009003' });

    send(dentro.socket, { type: 'chat.send', body: 'solo para 9001' });
    await waitFor(dentro.frames, (frame) => frame.type === 'chat.message');

    assert.equal(
      fuera.frames.some((frame) => frame.type === 'chat.message'),
      false
    );
  });

  it('el historial llega al que entra despues', async () => {
    const primero = await openRoom();
    send(primero.socket, { type: 'chat.send', body: 'mensaje previo' });
    await waitFor(primero.frames, (frame) => frame.type === 'chat.message');

    const segundo = await openRoom(ROOM, { sub: '00000000-0000-0000-0000-000000009004' });
    const history = await waitFor(segundo.frames, (frame) => frame.type === 'chat.history');
    assert.equal(history.messages.length, 1);
    assert.equal(history.messages[0].body, 'mensaje previo');
  });

  it('responde pong al ping de aplicacion', async () => {
    const { socket, frames } = await openRoom();
    send(socket, { type: 'ping' });
    await waitFor(frames, (frame) => frame.type === 'pong');
  });
});

describe('validacion de marcos', () => {
  it('400 ante JSON invalido, tipo desconocido o cuerpo vacio', async () => {
    const { socket, frames } = await openRoom();

    socket.send('no soy json');
    await waitFor(frames, (frame) => frame.type === 'error' && /JSON/.test(frame.message));

    send(socket, { type: 'chat.inventado' });
    await waitFor(frames, (frame) => frame.type === 'error' && /desconocido/.test(frame.message));

    send(socket, { type: 'chat.send', body: '   ' });
    await waitFor(frames, (frame) => frame.type === 'error' && /vacio/.test(frame.message));
  });

  it('400 si el cuerpo pasa los 500 caracteres', async () => {
    const { socket, frames } = await openRoom();
    send(socket, { type: 'chat.send', body: 'x'.repeat(501) });

    const error = await waitFor(frames, (frame) => frame.type === 'error');
    assert.equal(error.status, 400);

    const { rows } = await query('SELECT count(*)::int AS total FROM chat_message WHERE room_id = $1', [ROOM]);
    assert.equal(rows[0].total, 0);
  });

  it('429 al sexto mensaje dentro de la ventana', async () => {
    const { socket, frames } = await openRoom();

    for (let i = 0; i < 6; i += 1) {
      send(socket, { type: 'chat.send', body: `mensaje ${i}` });
    }

    const error = await waitFor(frames, (frame) => frame.type === 'error');
    assert.equal(error.status, 429);

    // Los 5 primeros si se guardaron: el limite frena, no descarta todo.
    const { rows } = await query('SELECT count(*)::int AS total FROM chat_message WHERE room_id = $1', [ROOM]);
    assert.equal(rows[0].total, 5);
  });
});
