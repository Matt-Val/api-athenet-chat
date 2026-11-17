import { config } from '../config.js';

/*
    POST /api/ws/ticket lleva Authorization, asi que el navegador manda un OPTIONS
    de preflight antes y sin respuesta bloquea la llamada entera, en silencio: con
    curl funciona igual, por eso el error solo aparece desde una pagina.
    El handshake del WS no pasa por aqui, pero comparte la lista blanca.
*/
const PREFLIGHT_MAX_AGE_SECONDS = 86_400;

export function cors(req, res, next) {
  const origin = req.headers.origin;

  // Sin Origin no hay navegador (curl, un test): CORS no aplica.
  if (!origin) {
    return next();
  }

  // Siempre, incluso al rechazar: sin esto un proxy podria servirle a un origen
  // la respuesta cacheada de otro.
  res.setHeader('Vary', 'Origin');

  if (!config.ws.allowedOrigins.includes(origin)) {
    // Sin cabecera, el navegador bloquea solo. Un 403 explicito le confirmaria a
    // una pagina ajena que el servicio existe.
    return next();
  }

  // El origen concreto, nunca "*": con * el navegador prohibe Authorization.
  res.setHeader('Access-Control-Allow-Origin', origin);

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Max-Age', String(PREFLIGHT_MAX_AGE_SECONDS));

    // Se corta aqui: el navegador NO adjunta el Authorization al OPTIONS, asi que
    // pasar por requireAuth daria 401 y la peticion real nunca saldria.
    return res.status(204).end();
  }

  return next();
}
