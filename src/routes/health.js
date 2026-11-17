import { Router } from 'express';

export const healthRouter = Router();

// Sin token (lo consulta Docker) y sin tocar la base: responde "el proceso esta
// vivo". Si dependiera de Postgres, un reinicio de la base haria que el
// orquestador matara un servicio sano.
healthRouter.get('/health', (_req, res) => {
  res.status(200).json({ status: 'UP' });
});
