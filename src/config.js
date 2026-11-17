/*
    Se valida al cargar el modulo: si falta una variable preferimos que el proceso
    no arranque, y no descubrirlo con un 500 en la primera peticion. El .env lo
    carga Node con --env-file, por eso no hay ninguna libreria.
*/
const REQUIRED_VARS = [
  'DATABASE_URL',
  'COGNITO_ISSUER_URI',
  'COGNITO_CLIENT_ID',
  'COGNITO_USERINFO_URI',
];

function readRequired() {
  const missing = REQUIRED_VARS.filter((name) => {
    const value = process.env[name];
    return value === undefined || value.trim() === '';
  });

  if (missing.length > 0) {
    // Todas las que faltan, no solo la primera.
    throw new Error(
      `Faltan variables de entorno obligatorias: ${missing.join(', ')}. ` +
        'Copia .env.example a .env y completa los valores.'
    );
  }
}

function readPositiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`La variable ${name} debe ser un entero positivo, se recibio "${raw}".`);
  }
  return parsed;
}

readRequired();

export const config = Object.freeze({
  port: readPositiveInt('PORT', 8086),

  databaseUrl: process.env.DATABASE_URL,

  cognito: Object.freeze({
    issuerUri: process.env.COGNITO_ISSUER_URI,
    clientId: process.env.COGNITO_CLIENT_ID,
    userInfoUri: process.env.COGNITO_USERINFO_URI,
  }),

  ws: Object.freeze({
    // Lista blanca del handshake. Se normaliza aqui para que comparar sea trivial.
    allowedOrigins: Object.freeze(
      (process.env.WS_ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin !== '')
    ),
    ticketTtlSeconds: readPositiveInt('WS_TICKET_TTL_SECONDS', 30),
  }),
});
