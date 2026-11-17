-- Esquema inicial de MS-Chat. El chat vive aparte de MS-Social a proposito:
-- un mensaje es un hecho historico de alto volumen y no debe compartir base con
-- el perfil del usuario (misma decision D2: ningun servicio lee el esquema de otro).

-- Up Migration

-- Ticket de un solo uso para abrir el WebSocket.
--   El navegador no puede mandar cabeceras en el handshake de un WebSocket, asi
--   que no hay forma de enviar el access token de Cognito ahi. El cliente pide
--   un ticket por HTTP (ya autenticado) y lo canjea en la URL del WS.
--
--   ticket_hash : SHA-256 en hexadecimal del ticket. Se guarda SOLO el hash,
--                 nunca el valor crudo: si alguien lee esta tabla no puede
--                 abrir conexiones en nombre de otro. Mismo criterio que una
--                 password. CHAR(64) porque un SHA-256 en hex mide exactamente eso.
--   display_name: se resuelve contra /oauth2/userInfo al emitir el ticket, no al
--                 canjearlo, para no depender de Cognito durante el handshake.
--   redeemed_at : NULL = sin usar. El canje es un UPDATE condicional sobre esta
--                 columna, por eso basta una sola sentencia para garantizar un uso.
--   target      : la sala para la que se emitio. Sin esto un ticket pedido para
--                 MATCH-1 serviria para entrar a cualquier sala, porque el
--                 handshake solo comprueba que el ticket sea valido. Hoy todas
--                 las salas son abiertas y no cambia nada; el dia que exista una
--                 restringida, seria un agujero.
CREATE TABLE ws_ticket (
    ticket_hash  CHAR(64)     NOT NULL,
    cognito_sub  VARCHAR(36)  NOT NULL,
    display_name VARCHAR(256) NOT NULL,
    target       VARCHAR(64)  NOT NULL,
    issued_at    TIMESTAMPTZ  NOT NULL,
    expires_at   TIMESTAMPTZ  NOT NULL,
    redeemed_at  TIMESTAMPTZ,
    CONSTRAINT pk_ws_ticket PRIMARY KEY (ticket_hash)
);

-- La purga periodica borra por expires_at; sin este indice haria un seq scan
-- sobre toda la tabla cada vez que corre.
CREATE INDEX idx_ws_ticket_expires_at ON ws_ticket (expires_at);

-- Mensajes del chat.
--   message_id          : lo asigna la aplicacion (crypto.randomUUID), NO la base.
--                         Asi el servidor puede confirmar el mensaje al emisor y
--                         difundirlo al resto con el mismo id sin esperar el INSERT.
--   room_id / room_type : la sala es un ID de otro servicio ("MATCH-1"), sin clave
--                         foranea, porque Chat no conoce el esquema de Competencia.
--   author_display_name : copia (snapshot) del nombre con el que se envio el
--                         mensaje. Chat no puede consultar la base de Social, y
--                         aunque pudiera, un mensaje viejo debe conservar el
--                         nombre que tenia su autor en ese momento.
--   body                : VARCHAR(500) es el limite que valida tambien la API;
--                         la base es la ultima linea de defensa, no la unica.
CREATE TABLE chat_message (
    message_id          UUID         NOT NULL,
    room_id             VARCHAR(64)  NOT NULL,
    room_type           VARCHAR(16)  NOT NULL,
    author_sub          VARCHAR(36)  NOT NULL,
    author_display_name VARCHAR(256) NOT NULL,
    body                VARCHAR(500) NOT NULL,
    sent_at             TIMESTAMPTZ  NOT NULL,
    CONSTRAINT pk_chat_message PRIMARY KEY (message_id)
);

-- La unica consulta de lectura que importa es "ultimos N mensajes de una sala":
-- el orden DESC en el indice evita ordenar en memoria al paginar el historial.
CREATE INDEX idx_chat_message_room_sent_at ON chat_message (room_id, sent_at DESC);

-- Down Migration

DROP TABLE chat_message;
DROP TABLE ws_ticket;
