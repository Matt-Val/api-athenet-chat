import express from 'express';

import { UpstreamError } from './auth/cognito.js';
import { startPurgeJob } from './auth/ticket.js';
import { config } from './config.js';
import { closePool } from './db.js';
import { cors } from './middleware/cors.js';
import { healthRouter } from './routes/health.js';
import { ticketRouter } from './routes/ticket.js';
import { attachWebSocketServer } from './ws/server.js';

const app = express();

// Aqui solo entran JSON diminutos; el default de express son 100kb.
app.use(express.json({ limit: '8kb' }));

// Antes de las rutas: el preflight tiene que responderse sin pasar por requireAuth.
app.use(cors);

app.use(healthRouter);
app.use(ticketRouter);

// Sin esto express devuelve su pagina HTML y un cliente que espera JSON recibe
// texto que no puede parsear.
app.use((req, res) => {
  res.status(404).json(apiError(404, 'Not Found', `No existe el recurso ${req.method} ${req.path}.`));
});

// Replica el ApiError de los servicios Java para que el frontend trate los
// errores de todo Athenet con el mismo codigo.
app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  if (error?.type === 'entity.parse.failed' || error?.status === 400) {
    return res.status(400).json(apiError(400, 'Bad Request', 'El cuerpo de la peticion no es JSON valido.'));
  }

  if (error?.type === 'entity.too.large') {
    return res.status(413).json(apiError(413, 'Payload Too Large', 'El cuerpo de la peticion es demasiado grande.'));
  }

  if (error instanceof UpstreamError) {
    // 503 y no 500: el problema esta en Cognito, no en este servicio.
    console.warn('[http] fallo un servicio externo:', error.message);
    return res.status(503).json(apiError(503, 'Service Unavailable', error.message));
  }

  // Se registra completo, pero al cliente no se le filtra el stack.
  console.error('[http] error inesperado:', error);
  return res
    .status(500)
    .json(apiError(500, 'Internal Server Error', 'Ocurrio un error inesperado. Intenta nuevamente mas tarde.'));
});

function apiError(status, error, message) {
  return { timestamp: new Date().toISOString(), status, error, message };
}

const server = app.listen(config.port, () => {
  console.log(`[chat] escuchando en http://localhost:${config.port}`);
  console.log(`[chat] WebSocket en ws://localhost:${config.port}/ws/chat`);
});

// Al MISMO servidor HTTP: asi el handshake viaja por el 8086 como cualquier
// peticion y no hay que abrir otro puerto en el Security Group.
attachWebSocketServer(server);

startPurgeJob();

// Docker manda SIGTERM y espera 10s. Cerrar el pool evita que Postgres quede
// con conexiones colgadas.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`[chat] recibido ${signal}, cerrando...`);
    server.close(async () => {
      await closePool().catch(() => {});
      process.exit(0);
    });
  });
}
