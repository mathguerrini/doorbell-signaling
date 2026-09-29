# Visiophone — Serveur de signalisation + PWA résidente

Serveur Node.js à trois rôles :

1. **Relai de signalisation WebSocket** pour établir la connexion WebRTC P2P entre l'ESP32-P4 et un navigateur/PWA (aucun flux audio/vidéo ne transite par le serveur, uniquement l'échange SDP/ICE).
2. **Hébergement de la PWA résidente** (`public/`) — l'app installable sur le smartphone des résidents.
3. **Notifications Web Push** ciblées par appartement quand la sonnette est actionnée, et relai des infos résidents/adresse (`building_info`) poussées par le panneau d'administration embarqué de l'ESP32 vers la PWA.

Pour la vue d'ensemble du système (firmware, architecture globale), voir le [README à la racine du dépôt](../../README.md).

## Installation

```bash
cd visiophone_serveur/main
npm install
```

## Variables d'environnement

| Variable | Défaut | Description |
|----------|--------|--------------|
| `PORT` | `8080` | Port HTTP + WebSocket |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | clés de démo codées en dur dans `server.js` | Clés Web Push (protocole VAPID) — à remplacer en production par vos propres clés (`npx web-push generate-vapid-keys`) |

## Lancement

```bash
# Mode normal
npm start

# Avec logs détaillés
LOG_LEVEL=debug node server.js

# Sur un port personnalisé
PORT=3000 node server.js
```

Le serveur écoute par défaut sur `http://localhost:8080`.

## Endpoints HTTP

| Endpoint | Description |
|----------|-------------|
| `GET /` | Redirige vers `/index.html` (PWA résidente) |
| `GET /legacy` | Page WebRTC "brute" (saisie de room, boutons appel/porte) — utilisée en `<iframe>` par l'onglet Caméra de la PWA, et utilisable seule pour du debug |
| `GET /api/vapid` | Clé publique VAPID, consommée par le navigateur pour s'abonner aux notifications push |
| `GET /api/building` | Dernières infos résidence (nom, adresse, appartements) poussées par le firmware — consommé par la PWA |
| `POST /api/subscribe` | Enregistre un abonnement Web Push : `{ subscription, apt }` |
| `GET /health` | État du serveur (rooms actives, connexions, messages, uptime) |
| `GET /rooms` | Liste des rooms actives et leur occupation |
| `GET /*` | Fichiers statiques servis depuis `public/` (PWA : `index.html`, `home.js`, `app.css`, `manifest.json`, `sw.js`, icônes) |

## Protocole WebSocket

Tous les messages sont en JSON. Une room = une session d'appel, 2 pairs max ; quand l'un des deux la quitte, l'autre en est aussi retiré (`peer_left`). Un ping/pong au niveau protocole WebSocket toutes les secondes purge les connexions mortes.

### Signalisation WebRTC (ESP32 ↔ navigateur/PWA, relayée telle quelle au pair de la room)

```json
{ "type": "join",      "room": "esp_aabbcc" }
{ "type": "leave" }
{ "type": "offer",     "sdp": "v=0\r\n..." }
{ "type": "answer",    "sdp": "v=0\r\n..." }
{ "type": "candidate", "candidate": { "candidate": "...", "sdpMid": "0", "sdpMLineIndex": 0 } }
{ "type": "cmd",       "cmd": "ring|door_opened|OPEN_DOOR|SETCODE:<code>|ACCEPT_CALL|DENY_CALL" }
```

Réponses serveur : `{ "type": "joined", "room", "peers" }`, `{ "type": "peer_joined" }`, `{ "type": "peer_left" }`, `{ "type": "full", "room" }`, `{ "type": "error", "message" }`.

### Notifications par appartement (indépendant d'une room active)

| Message | Sens | Effet |
|---------|------|-------|
| `{ "type": "ring", "apt", "room" }` | ESP32 → serveur | Mémorise l'appel en attente (30 s), le diffuse à tous les WebSocket connectés, et envoie une notification Web Push aux abonnés de cet appartement |
| `{ "type": "ring_deny", "apt", "room" }` | → serveur → tous | Diffusé à tous les clients (ex. la carte revient à l'état de repos si personne ne répond) |
| `{ "type": "register", "apt" }` | PWA → serveur | La PWA déclare l'appartement qu'elle représente ; si un `ring` est en attente pour cet appartement (< 30 s), il lui est renvoyé immédiatement |
| `{ "type": "get_pending_ring", "apt" }` | PWA → serveur | Interroge explicitement s'il y a un appel en attente pour cet appartement |
| `{ "type": "building_info", "residence_name", "building_address", "apartments": [...] }` | ESP32 → serveur | Poussé à la connexion et après chaque sauvegarde du panneau admin embarqué ; alimente `GET /api/building` |

## Notifications Web Push

1. La PWA récupère la clé publique via `GET /api/vapid` et s'abonne (`pushManager.subscribe`).
2. Elle envoie l'abonnement au serveur via `POST /api/subscribe` avec l'appartement représenté (`{ subscription, apt }`), stocké en mémoire.
3. À un `ring`, le serveur envoie une notification Web Push aux abonnés de cet appartement, avec deux actions natives (« Répondre » / « Refuser ») gérées par le service worker ([public/sw.js](public/sw.js)).
4. Un clic (ou l'action « Répondre ») ouvre/ramène la PWA au premier plan et lui demande d'afficher le popup de sonnerie.
5. Un abonnement expiré (erreur 410/404 de l'API push) est automatiquement retiré de la mémoire.

## App résidente (PWA, `public/`)

SPA à 4 onglets (voir [public/index.html](public/index.html) / [public/home.js](public/home.js)) :

- Accueil — nom et adresse de la résidence (poussés par le visiophone), bouton d'ouverture du portail.
- Caméra — `<iframe>` vers `/legacy`, utilisée pendant un appel.
- Historique — emplacement prévu, pas encore alimenté.
- Profil — choix de l'appartement représenté par ce téléphone (persisté en `localStorage`), activation des notifications push.

Installable (« Ajouter à l'écran d'accueil ») grâce à [public/manifest.json](public/manifest.json) et [public/sw.js](public/sw.js).

## Persistance

Aucune persistance disque : `rooms`, `pushSubscriptions`, `pendingRings` et `buildingInfo` vivent en mémoire et sont perdus à chaque redémarrage/redéploiement. Sans impact pratique pour `buildingInfo` : le firmware la renvoie à chaque (re)connexion WebSocket.

## Déploiement

Instance de référence déployée sur Render, à l'URL configurée côté firmware (`MY_SIGNALING_SERVER_URI` dans [settings.h](../../visiophone_esp32/main/settings.h)). En local, lancez `npm start` puis pointez le firmware sur `ws://<IP_DU_PC>:8080` (commande console `server` ou `MY_SIGNALING_SERVER_URI`) ; pour un test depuis un mobile hors réseau local, voir le tunnel ngrok décrit dans le [README racine](../../README.md).

## STUN/TURN

La page `/legacy` embarque des identifiants TURN (compte Metered) codés en dur dans `server.js`, utilisés pour la connectivité WebRTC derrière un NAT restrictif — à remplacer par votre propre compte si celui-ci change ou expire.
