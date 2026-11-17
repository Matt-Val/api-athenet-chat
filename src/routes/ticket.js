import { Router } from 'express';

import { fetchUserInfo, requireAuth } from '../auth/cognito.js';
import { issue } from '../auth/ticket.js';

export const ticketRouter = Router();

// Lista blanca por forma, no por existencia: Chat no puede preguntarle a
// Competencia si el partido 7 existe, pero si impedir que inventen salas.
const TARGET_PATTERN = /^(GLOBAL|COMPETITION-\d{1,18}|MATCH-\d{1,18})$/;

// Sale de userInfo y no del cuerpo: si lo mandara el cliente, cualquiera
// escribiria con el nombre de otro.
function buildDisplayName(userInfo) {
  const parts = [userInfo.givenName, userInfo.familyName].filter(
    (part) => typeof part === 'string' && part.trim() !== ''
  );

  if (parts.length > 0) {
    return parts.join(' ').slice(0, 256);
  }

  if (typeof userInfo.email === 'string' && userInfo.email.trim() !== '') {
    return userInfo.email.trim().slice(0, 256);
  }

  // La columna es NOT NULL y un mensaje sin autor no se puede dibujar.
  return 'Usuario Athenet';
}

ticketRouter.post('/api/ws/ticket', requireAuth, async (req, res, next) => {
  try {
    const target = req.body?.target;

    if (typeof target !== 'string' || !TARGET_PATTERN.test(target)) {
      return res.status(400).json({
        timestamp: new Date().toISOString(),
        status: 400,
        error: 'Bad Request',
        message:
          'El campo "target" es obligatorio y debe ser GLOBAL, COMPETITION-<numero> o MATCH-<numero>.',
      });
    }

    const userInfo = await fetchUserInfo(req.accessToken);
    const displayName = buildDisplayName(userInfo);

    // Queda ATADO a esta sala: el handshake compara este target con el roomId
    // de la URL, asi que un ticket de MATCH-1 no abre MATCH-2.
    const { ticket, expiresIn } = await issue(req.auth.sub, displayName, target);

    // 200 y no 201: no hay recurso que apuntar en un Location.
    return res.status(200).json({ ticket, expiresIn });
  } catch (error) {
    return next(error);
  }
});
