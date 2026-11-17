import { createRemoteJWKSet, jwtVerify } from 'jose';

import { config } from '../config.js';

// El access token de Cognito no trae "aud" sino "client_id", asi que la
// audiencia se compara a mano mas abajo.
const JWKS_URI = new URL(`${config.cognito.issuerUri}/.well-known/jwks.json`);

// Una vez por proceso: las claves quedan en memoria y validar no cuesta red.
const jwks = createRemoteJWKSet(JWKS_URI, {
  cooldownDuration: 30_000,
  cacheMaxAge: 600_000,
});

const USERINFO_TIMEOUT_MS = 5_000;

export class UpstreamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UpstreamError';
    // 503: el servicio esta bien, el de al lado no.
    this.status = 503;
  }
}

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
  }
}

export async function verifyAccessToken(token) {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, jwks, {
      issuer: config.cognito.issuerUri,
      algorithms: ['RS256'],
    }));
  } catch {
    // No se filtra el detalle: firma mala, expirado o kid desconocido son lo mismo.
    throw new AuthError('Token invalido o expirado.');
  }

  // Sin esto, un id token del mismo User Pool pasaria la validacion de firma.
  if (payload.token_use !== 'access') {
    throw new AuthError('Se requiere un access token de Cognito.');
  }

  // Otra app del mismo pool usa las mismas claves: el client_id la distingue.
  if (payload.client_id !== config.cognito.clientId) {
    throw new AuthError('El token no fue emitido para esta aplicacion.');
  }

  if (typeof payload.sub !== 'string' || payload.sub === '') {
    throw new AuthError('El token no trae un sub valido.');
  }

  return {
    sub: payload.sub,
    groups: Array.isArray(payload['cognito:groups']) ? payload['cognito:groups'] : [],
  };
}

// Guarda el token crudo ademas de la identidad: userInfo se consulta con el
// mismo bearer del usuario.
export async function requireAuth(req, res, next) {
  const header = req.get('authorization');

  if (!header || !header.toLowerCase().startsWith('bearer ')) {
    return res.status(401).json(unauthorized('Falta la cabecera Authorization: Bearer.'));
  }

  const token = header.slice('bearer '.length).trim();
  if (token === '') {
    return res.status(401).json(unauthorized('El token esta vacio.'));
  }

  try {
    req.auth = await verifyAccessToken(token);
    req.accessToken = token;
    return next();
  } catch (error) {
    if (error instanceof AuthError) {
      return res.status(401).json(unauthorized(error.message));
    }
    // Un fallo de red al traer el JWKS no es culpa del cliente.
    return next(error);
  }
}

// Mismo cuerpo de error que el resto de Athenet (ApiError en los servicios Java).
function unauthorized(message) {
  return {
    timestamp: new Date().toISOString(),
    status: 401,
    error: 'Unauthorized',
    message,
  };
}

// El access token no trae email ni nombre: hay que preguntarselos a Cognito.
export async function fetchUserInfo(accessToken) {
  let response;
  try {
    response = await fetch(config.cognito.userInfoUri, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(USERINFO_TIMEOUT_MS),
    });
  } catch (error) {
    throw new UpstreamError(`No se pudo contactar a Cognito: ${error.message}`);
  }

  if (!response.ok) {
    throw new UpstreamError(`Cognito respondio ${response.status} en userInfo.`);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new UpstreamError('Cognito devolvio una respuesta que no es JSON.');
  }

  // Tolerante con terceros: se ignora todo lo que Cognito agregue.
  return {
    sub: body.sub ?? null,
    email: body.email ?? null,
    givenName: body.given_name ?? null,
    familyName: body.family_name ?? null,
  };
}
