# Build en dos etapas: la imagen final no carga el cache de npm ni los fuentes
# que no se usan en runtime.
FROM node:22-alpine AS deps
WORKDIR /app

# Primero los manifiestos: si no cambian, Docker reutiliza la capa de
# dependencias y no las vuelve a instalar en cada build.
COPY package.json package-lock.json ./
# npm ci y no npm install: instala exactamente lo del lockfile y falla si no calza.
RUN npm ci --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/
COPY migrations/ ./migrations/

# La imagen de Node ya trae el usuario "node" (uid 1000) sin privilegios.
USER node
EXPOSE 8086

# Las migraciones corren al arrancar, igual que Flyway en los servicios Java: si
# fallan, el contenedor no levanta, que es lo correcto.
#
# El "exec" del final NO es decorativo: sin el, sh queda como PID 1 y no le pasa
# el SIGTERM de Docker a Node, asi que el apagado ordenado de index.js nunca
# corre y el proceso muere a los 10s de un SIGKILL.
CMD ["sh", "-c", "npm run migrate:prod && exec node src/index.js"]
