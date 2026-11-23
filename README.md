<p align="center">
  <img src="docs/img/banner.png" alt="Athenet Banner" width="100%">
</p>

<p align="center">
Microservicio de chat en vivo de <strong>Athenet</strong>: salas por partido, competencia o globales, sobre WebSocket, para los usuarios públicos autenticados con AWS Cognito.
</p>

<h4 align="center"><strong>
Athenet ORG - <a href="https://github.com/fabetabilo/web-athenet">Athenet Público</a>
</br>
<a href="#control-de-acceso-y-roles">Control de Acceso y Roles</a> - <a href="#desarrollo-local">Desarrollo Local</a> - <a href="#despliegue">Despliegue</a>
</strong></h4>

### Stack

<div align="center">

[![Node.js](https://img.shields.io/badge/Node.js_22-%23339933.svg?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express_5-%23000000.svg?style=for-the-badge&logo=express&logoColor=white)](https://expressjs.com/)
[![WebSocket](https://img.shields.io/badge/WebSocket-%23010101.svg?style=for-the-badge&logo=socketdotio&logoColor=white)](https://github.com/websockets/ws)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-%23336791.svg?style=for-the-badge&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![AWS Cognito](https://img.shields.io/badge/AWS_Cognito-%23DD344C.svg?style=for-the-badge&logo=amazoncognito&logoColor=white)](https://aws.amazon.com/cognito/)
[![Docker](https://img.shields.io/badge/Docker-%232496ED.svg?style=for-the-badge&logo=docker&logoColor=white)](https://www.docker.com/)
[![GitHub Actions](https://img.shields.io/badge/GitHub_Actions-%232088FF.svg?style=for-the-badge&logo=githubactions&logoColor=white)](https://github.com/features/actions)

</div>

* **Runtime:** Node.js 22 (ESM). El `.env` lo carga Node con `--env-file`, sin `dotenv`.
* **Framework HTTP:** [Express 5](https://expressjs.com/), solo para las dos rutas REST.
* **WebSocket:** [`ws`](https://github.com/websockets/ws) montado con `noServer: true` sobre el mismo servidor HTTP.
* **Persistencia:** PostgreSQL con [`pg`](https://node-postgres.com/), consultas con parámetros, sin ORM.
* **Esquema:** [`node-pg-migrate`](https://salsita.github.io/node-pg-migrate/) con migraciones en SQL plano; corren al arrancar el contenedor.
* **Autenticación:** [`jose`](https://github.com/panva/jose) validando el **access token** de AWS Cognito.
* **Tests:** el runner nativo de Node (`node --test`), sin dependencias de testing.
* **Contenerización y despliegue:** Docker (multi-stage) + GitHub Actions (test → build → push a Docker Hub → deploy por SSH).

### ms-chat

Este microservicio es el chat en vivo que acompaña al tablero del partido. Convive con el tablero de marcador como **servicio separado**: la pantalla del partido abre dos WebSockets, uno para el marcador y otro para el chat.

Es un servicio **en Node y no en Spring Boot** —el único del proyecto— porque su trabajo es mantener miles de conexiones abiertas haciendo muy poco en cada una, que es justo donde un modelo de un hilo por petición rinde peor.

Salas admitidas: `GLOBAL`, `COMPETITION-<id>` y `MATCH-<id>`. Se validan **por forma, no por existencia**: Chat no puede preguntarle a Competencia si el partido 7 existe, pero sí impedir que alguien invente salas arbitrarias y use el servicio como chat genérico.

#### REST

| Método | Endpoint | Acceso | Descripción |
| :--- | :--- | :--- | :--- |
| `GET` | `/health` | Público | Health check de Docker y del workflow de deploy |
| `POST` | `/api/ws/ticket` | `Bearer` de Cognito | Emite un ticket de un solo uso para abrir el WebSocket |

```jsonc
// POST /api/ws/ticket   →   {"target": "MATCH-1"}
{ "ticket": "QmFzZTY0VXJsRGUyOUJ5dGVzQWxlYXRvcmlvcw", "expiresIn": 30 }
```

#### WebSocket

```
ws://<host>:8086/ws/chat?ticket=<ticket>&roomId=MATCH-1
```

**Un ticket por conexión.** Se gasta al abrir y no se puede reutilizar.

Marcos del **servidor al cliente**:

| `type` | Cuándo | Contenido |
| :--- | :--- | :--- |
| `chat.ready` | Al conectar, **siempre primero** | `roomId` y `you: { sub, displayName }` |
| `chat.history` | Justo después | Los últimos 50 mensajes, en orden cronológico |
| `chat.message` | Al publicarse un mensaje | `data` con el mensaje y el `clientMessageId` del emisor |
| `error` | Marco inválido o límite excedido | `status` y `message` |
| `pong` | Respuesta a `ping` | — |

Marcos del **cliente al servidor**:

```jsonc
{ "type": "chat.send", "clientMessageId": "<uuid>", "body": "vamos equipo" }
{ "type": "ping" }
```

El `clientMessageId` vuelve tal cual en el eco para que el emisor reemplace su burbuja optimista en vez de duplicarla. **No se persiste.**

#### Límites

| Límite | Valor | Dónde |
| :--- | :--- | :--- |
| Vida del ticket | 30 s | `WS_TICKET_TTL_SECONDS` |
| Largo del mensaje | 500 caracteres | API y columna de la base |
| Ritmo de envío | 5 mensajes / 10 s por sesión | Ventana deslizante |
| Sesiones por usuario | 3 | Constante en `ws/server.js` |
| Historial al entrar | 50 mensajes | Constante en `ws/messages.js` |

### Control de Acceso y Roles

El navegador **no puede mandar cabeceras en el handshake de un WebSocket**, así que el access token de Cognito no cabe ahí. De ese hecho sale todo el diseño de seguridad del servicio.

El flujo es en dos tiempos: el cliente pide un ticket **por HTTP**, donde sí puede autenticarse, y lo canjea en la URL del WebSocket.

1. **`POST /api/ws/ticket`** con `Authorization: Bearer <access token>`. Se valida la firma contra el JWKS de Cognito (cacheado en memoria) y tres claims más: `iss`, `client_id` —el access token de Cognito **no trae `aud`**— y `token_use=access`, sin el cual un **id token** del mismo pool pasaría la validación de firma.
2. El `display_name` se resuelve contra Cognito **al emitir** el ticket, nunca al canjearlo: así el handshake no depende de que Cognito responda. El camino lo decide el **scope** del token: un login por SDK (la web, Amplify SRP) trae `aws.cognito.signin.user.admin` y no `openid`, así que va a `GetUser`; un login por Hosted UI (el `dev-client`) trae `openid` y va a `/oauth2/userInfo`, que exige ese scope.
3. El ticket se guarda **solo como SHA-256**. Quien lea la tabla no puede abrir conexiones con lo que ve.
4. **El canje es un único `UPDATE` condicional.** Con un `SELECT` y después un `UPDATE`, dos canjes simultáneos leerían `redeemed_at IS NULL` antes de que ninguno escribiera y ambos abrirían conexión.

Respuestas del handshake:

| HTTP | Cuándo |
| :--- | :--- |
| `404` | La ruta no es `/ws/chat` |
| `400` | Falta el `ticket` o el `roomId` |
| `401` | Ticket inexistente, ya usado o vencido |
| `403` | Origen fuera de la lista blanca, **o ticket emitido para otra sala** |
| `429` | El usuario ya tiene 3 sesiones abiertas |

> El navegador **no expone** el código HTTP de un handshake rechazado: solo informa que la conexión falló, con `code 1006`. Para verlos hay que mirar los logs del servicio o correr `npm test`.

**El autor y la hora los pone el servidor, siempre.** Del cliente se toma únicamente el texto del mensaje. Si se aceptaran del cliente, cualquiera escribiría con el nombre de otro.

Los errores siguen el formato del proyecto (`ApiError`: `timestamp`, `status`, `error`, `message`), el mismo que devuelven los servicios Java, para que el frontend trate los errores de todo Athenet con un solo código.

### Desarrollo Local

#### 1. Verificación de dependencias del entorno

* **Node.js 22.9 o superior** (se usan `--env-file`, `--env-file-if-exists` y `node --test`).
* **Docker:** para levantar PostgreSQL con el `docker-compose.yml` incluido.
* **Un User Pool de Cognito** accesible, solo si se quiere probar el flujo completo. Los tests no lo necesitan.

```bash
node --version
```

#### 2. Instalar dependencias

```bash
npm ci
```

#### 3. Configuración del entorno (`.env`)

```bash
cp .env.example .env
```

**Nunca subas `.env` al repositorio** (ya está en `.gitignore`).

| Variable | Por defecto | Descripción |
| :--- | :--- | :--- |
| `PORT` | `8086` | HTTP y WebSocket comparten puerto |
| `DATABASE_URL` | **sin valor** | La leen `pg` y `node-pg-migrate`: una sola fuente de verdad |
| `DB_PASSWORD` | `chat_local` | Solo la usa `docker-compose` para inicializar Postgres |
| `COGNITO_ISSUER_URI` | **sin valor** | `https://cognito-idp.<region>.amazonaws.com/<userPoolId>` |
| `COGNITO_CLIENT_ID` | **sin valor** | App Client; se compara contra el claim `client_id` |
| `COGNITO_USERINFO_URI` | **sin valor** | `https://<dominio>.auth.<region>.amazoncognito.com/oauth2/userInfo`. Solo para tokens de Hosted UI; los del SDK usan `GetUser` en el host del issuer |
| `WS_ALLOWED_ORIGINS` | `http://localhost:5173` | Lista blanca, separada por comas. La comparten el handshake y el preflight de CORS |
| `WS_TICKET_TTL_SECONDS` | `30` | Vida del ticket |

Las cuatro sin valor por defecto son deliberadas: si falta alguna, el proceso **no arranca**, en vez de fallar con un `500` en la primera petición.

#### 4. Base de datos

```bash
docker compose up -d
npm run migrate
```

PostgreSQL queda en el **5436** (el 5432 y el 5435 ya están tomados por otros servicios del proyecto). Las migraciones crean `ws_ticket` y `chat_message`.

Para empezar de cero: `docker compose down -v`.

#### 5. Servidor de desarrollo

```bash
npm run dev
```

El servicio queda en `http://localhost:8086/` y el WebSocket en `ws://localhost:8086/ws/chat`.

#### 6. Cliente de prueba

`dev-client/` tiene una página que hace el flujo completo —PKCE contra Cognito, pedido de ticket y apertura del WebSocket— además de cuatro pruebas de rechazo a un clic. **No es el frontend de producción**: existe para probar a mano y como referencia de integración.

```bash
python3 -m http.server 5173 -d dev-client
```

Tiene que servirse en `http://localhost:5173/` **exactamente**: es el único origen de `WS_ALLOWED_ORIGINS` y la callback registrada en Cognito, que compara la URL completa incluida la barra final.

#### 7. Ejecución de tests

```bash
docker compose up -d   # los tests corren contra el Postgres real
npm test
```

16 casos de integración en `test/ws-handshake.test.js`, contra la base y no contra un doble: lo que se prueba es el canje atómico del ticket, y un *mock* del `UPDATE` condicional probaría el *mock*.

* **Rechazos del handshake:** los seis códigos de la tabla de arriba, incluido el ticket emitido para otra sala y el segundo canje del mismo ticket.
* **Sesión abierta:** `chat.ready` antes que `chat.history`, difusión dentro de la sala, aislamiento entre salas, historial para quien entra después, y que el `authorDisplayName` que mande el cliente se ignore.
* **Validación de marcos:** JSON inválido, tipo desconocido, cuerpo vacío, cuerpo de más de 500 caracteres y el límite de ritmo.

### Despliegue

Imagen Docker multi-stage (`node:22-alpine`, usuario `node` sin privilegios) desplegada con `.github/workflows/ci-cd.yml`:

1. **Test:** `npm test` contra un servicio de PostgreSQL levantado en el propio job. Las variables de Cognito son de relleno: los tests emiten tickets llamando a `issue()` directo y nunca validan un token, así que el pipeline **no necesita el User Pool**.
2. **Build & Push:** builda la imagen y la publica en Docker Hub.
3. **Deploy** (manual, `workflow_dispatch`): SSH a la EC2, usando los secrets `EC2_APP_HOST`, `EC2_SSH_USER`, `EC2_SSH_KEY` y `DOCKERHUB_TOKEN`. Termina con un gate de salud contra `/health` que falla el workflow si el contenedor no responde.

Las credenciales de producción viven en `/opt/athenet/chat.env` dentro de la EC2, cargado con `docker --env-file`. La plantilla es `production.env.example`.

**Las migraciones corren al arrancar el contenedor**, igual que Flyway en los servicios Java: si fallan, el contenedor no levanta.

### Estructura del Proyecto

```text
src/
├── index.js            # Ensambla express, engancha el WebSocket y maneja el apagado ordenado
├── config.js           # Lee y valida el entorno una vez, al arrancar
├── db.js               # El pool de pg; todas las consultas van con parámetros
├── auth/
│   ├── cognito.js      # Valida el access token y resuelve el nombre (GetUser o userInfo según el scope)
│   └── ticket.js       # Emite, canjea y purga los tickets de un solo uso
├── middleware/
│   └── cors.js         # Responde el preflight del navegador
├── routes/
│   ├── health.js       # GET /health
│   └── ticket.js       # POST /api/ws/ticket
└── ws/
    ├── server.js       # El handshake y el ciclo de vida de la sesión
    ├── registry.js     # Qué sesiones hay en cada sala (en memoria)
    └── messages.js     # Persistencia e historial (PostgreSQL)

migrations/0001_init.sql  # ws_ticket y chat_message
test/                     # Tests de integración del handshake
dev-client/               # Página de prueba manual; NO es el frontend
```

### Decisiones de Diseño

**`noServer: true` y el `upgrade` enganchado a mano.** Es la única forma de rechazar con un **401 de verdad**. Si la librería completara el handshake, el socket ya existiría y solo se podría cerrar después, sin código de estado útil.

**El registro de salas vive en memoria.** Es rápido y se pierde al reiniciar, que es lo correcto: si el proceso se reinicia, las conexiones se cortan igual. Lo que sobrevive es la tabla `chat_message`.

**El emisor recibe su propio mensaje de vuelta.** Así todos pintan el mismo registro, con el mismo `messageId` y la misma hora. Si cada cliente pintara su versión local, un reloj desfasado bastaría para que el orden en pantalla no coincidiera entre dos personas.

**Las sesiones se registran *antes* de leer el historial**, y lo que llegue mientras tanto se encola. Al revés, un mensaje publicado durante la consulta no lo recibiría nadie; y sin la cola, llegaría antes que el historial y se pintaría desordenado.

**El `CMD` del Dockerfile termina en `exec`.** Sin él, `sh` queda como PID 1 y no le pasa el `SIGTERM` a Node, así que el apagado ordenado nunca corre y Docker mata el proceso a los 10 segundos dejando conexiones colgadas en Postgres.

### Pendiente

* **Una sola instancia.** El registro de salas es un `Map` en memoria del proceso: con dos instancias, los usuarios conectados a instancias distintas no se verían. Escalar exigiría un bus difundiendo a todas.
* **`wss://` para producción.** Una página servida por HTTPS **no puede** abrir una conexión `ws://`; el navegador la bloquea por contenido mixto, sin error atrapable. Hoy la demo funciona desde `http://localhost:5173`. Afecta igual al tablero en vivo, así que es una decisión conjunta del equipo.
* **Lectura anónima.** Hoy el chat exige sesión incluso para leer. Permitir que un anónimo vea los mensajes y pedir login solo al escribir sería más amable, a costa de un segundo camino en el código.
* **Moderación.** No existe rol de moderador y nadie puede borrar un mensaje.
