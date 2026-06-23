# Doorbell Signaling Server

Serveur de signalisation WebSocket pour établir une connexion WebRTC P2P
entre un ESP32 (esp-webrtc) et un navigateur web.

## Installation

```bash
npm install
```

## Lancement

```bash
# Mode normal
npm start

# Mode développement (rechargement auto)
npm run dev

# Avec logs détaillés
LOG_LEVEL=debug node server.js

# Sur un port différent
PORT=3000 node server.js
```

## Endpoints HTTP

| URL | Description |
|-----|-------------|
| `GET /health` | État du serveur (rooms actives, connexions) |
| `GET /rooms` | Liste des rooms et leur occupation |

## Protocole de messages

Tous les messages sont en JSON sur la connexion WebSocket.

### Messages client → serveur

```json
{ "type": "join",      "room": "esp_aabbcc" }
{ "type": "leave" }
{ "type": "offer",     "sdp": "v=0\r\n..." }
{ "type": "answer",    "sdp": "v=0\r\n..." }
{ "type": "candidate", "candidate": { "candidate": "...", "sdpMid": "0", "sdpMLineIndex": 0 } }
{ "type": "cmd",       "cmd": "ring" }
{ "type": "ping" }
```

### Messages serveur → client

```json
{ "type": "joined",      "room": "esp_aabbcc", "peers": 1 }
{ "type": "peer_joined" }
{ "type": "peer_left" }
{ "type": "full",        "room": "esp_aabbcc" }
{ "type": "error",       "message": "..." }
{ "type": "pong" }
```

### Commandes custom doorbell (relayées via `cmd`)

| `cmd`          | Direction          | Effet                         |
|----------------|--------------------|-------------------------------|
| `ring`         | ESP32 → navigateur | Sonnette appuyée              |
| `open_door`    | Navigateur → ESP32 | Demande d'ouverture de porte  |
| `door_opened`  | ESP32 → navigateur | Confirmation porte ouverte    |
| `accept_call`  | Navigateur → ESP32 | Appel accepté                 |
| `deny_call`    | Navigateur → ESP32 | Appel refusé                  |

## Flux de connexion typique

```
ESP32                  Serveur                 Navigateur
  |                       |                        |
  |-- join(room) -------->|                        |
  |<- joined(peers:1) ----|                        |
  |                       |<----- join(room) ------|
  |<- peer_joined --------|------ joined(peers:2)->|
  |                       |                        |
  |-- offer(sdp) -------->|------- offer(sdp) ---->|
  |                       |<------ answer(sdp) ----|
  |<- answer(sdp) --------|                        |
  |                       |                        |
  |-- candidate --------->|------- candidate ----->|
  |<- candidate ----------|<------ candidate ------|
  |                       |                        |
  |<======= connexion WebRTC P2P directe =========>|
  |                       |                        |
  |-- cmd(RING) --------->|------- cmd(ring) ----->|
  |<- cmd(ACCEPT_CALL) ---|<--- cmd(ACCEPT_CALL) --|
```
