'use strict';

/**
 * Doorbell WebRTC Signaling Server + Web UI
 * ------------------------------------------
 * Lance un seul processus Node.js qui :
 *   • Sert la page web de la sonnette sur  GET /
 *   • Expose l'API de debug sur            GET /health  et  GET /rooms
 *   • Gère la signalisation WebSocket sur  ws://<host>:<port>
 *
 * Protocole de messages (JSON) :
 *   join      { type, room }
 *   leave     { type }
 *   offer     { type, sdp }
 *   answer    { type, sdp }
 *   candidate { type, candidate }
 *   cmd       { type, cmd: "ring|open_door|door_opened|accept_call|deny_call" }
 *   ping      { type }
 */

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const webpush = require('web-push');

// Configuration VAPID (Mets ici les clés générées à l'étape 1)
const VAPID_KEYS = {
  publicKey: process.env.VAPID_PUBLIC_KEY || 'BMciinMRoHGsc8D2pJOZQxpyB_9Z4oDTKPz6Aec9xEiqay_7-SXujmjtXmitlfdKLdZ5LlYK7SqlyrXt0WUz2GQ',
  privateKey: process.env.VAPID_PRIVATE_KEY || '6B1krtccCKz0TJpZgLFbR5MY3sF1pnmf02ut0tHDH3s',
};

// Configurer web-push si les clés sont renseignées
if (VAPID_KEYS.publicKey !== 'BMciinMRoHGsc8D2pJOZQxpyB_9Z4oDTKPz6Aec9xEiqay_7-SXujmjtXmitlfdKLdZ5LlYK7SqlyrXt0WUz2GQI') {
  webpush.setVapidDetails(
    'mailto:mat7.guerrini@gmail.com', // Un email de contact requis par Apple/Google
    VAPID_KEYS.publicKey,
    VAPID_KEYS.privateKey
  );
}

// Stockage temporaire des abonnements de téléphones (en mémoire)
const pushSubscriptions = []; // Contiendra des objets { apt: "Apt 1A", sub: {...} }
const pendingRings = {}; // { "Apt 1A": { room, apt, ts } } — appels en cours, pour les résidents qui ouvrent l'app après la notif
// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  PORT:               process.env.PORT || 8080,
  MAX_PEERS_PER_ROOM: 2,
  PING_INTERVAL_MS:   15_000,
  LOG_LEVEL:          process.env.LOG_LEVEL || 'info',
};

// ─── Logger ──────────────────────────────────────────────────────────────────

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const COLORS = { debug: '\x1b[36m', info: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m', reset: '\x1b[0m' };
const log = {
  _print(level, ...a) {
    if (LEVELS[level] < LEVELS[CONFIG.LOG_LEVEL]) return;
    const ts = new Date().toISOString().replace('T',' ').slice(0,23);
    console.log(`${COLORS[level]}[${ts}] [${level.toUpperCase().padEnd(5)}]${COLORS.reset}`, ...a);
  },
  debug(...a){ this._print('debug',...a); },
  info(...a) { this._print('info', ...a); },
  warn(...a) { this._print('warn', ...a); },
  error(...a){ this._print('error',...a); },
};

// ─── État global ─────────────────────────────────────────────────────────────

const rooms = new Map();   // Map<roomId, Set<WebSocket>>
let totalConnections = 0;
let totalMessages    = 0;

// ─── Utilitaires WS ──────────────────────────────────────────────────────────

function send(ws, obj) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify(obj)); } catch(e) { log.warn('send err:', e.message); }
}

function getPeer(ws) {
  const room = rooms.get(ws._roomId);
  if (!room) return null;
  for (const p of room) if (p !== ws) return p;
  return null;
}

function leaveRoom(ws) {
  const roomId = ws._roomId;
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room) return;
  room.delete(ws);
  log.info(`[room:${roomId}] ${ws._id} parti (${room.size} restant)`);
  const peer = getPeer(ws);
  if (peer) send(peer, { type: 'peer_left' });
  if (room.size === 0) { rooms.delete(roomId); log.info(`[room:${roomId}] supprimée`); }
  ws._roomId = null;
}

// ─── Handlers de messages ────────────────────────────────────────────────────

const handlers = {
  join(ws, msg) {
    const roomId = (msg.room || '').trim().slice(0, 64);
    if (!roomId) return send(ws, { type: 'error', message: 'room manquante' });
    if (ws._roomId) leaveRoom(ws);
    if (!rooms.has(roomId)) rooms.set(roomId, new Set());
    const room = rooms.get(roomId);
    // Nettoyer les connexions mortes (fantomes) avant de verifier si la room est pleine
    for (const p of [...room]) {
      if (p.readyState !== WebSocket.OPEN) {
        room.delete(p);
        p._roomId = null;
        log.info(`[room:${roomId}] connexion morte retiree au join`);
      }
    }
    if (room.size >= CONFIG.MAX_PEERS_PER_ROOM)
      return send(ws, { type: 'full', room: roomId });
    room.add(ws);
    ws._roomId = roomId;
    log.info(`[room:${roomId}] ${ws._id} rejoint (${room.size}/2)`);
    send(ws, { type: 'joined', room: roomId, peers: room.size });
    const peer = getPeer(ws);
    if (peer) send(peer, { type: 'peer_joined' });
  },
  leave(ws)       { leaveRoom(ws); },
  offer(ws, msg) {
    const p = getPeer(ws);
    if (p) {
        // NACK conservé : permet la retransmission des paquets perdus (anti-freeze)
        send(p, msg);
    } else {
        send(ws, { type: 'error', message: 'pas de pair' });
    }
},
  answer(ws, msg) { const p = getPeer(ws); if(p) send(p, msg); else send(ws,{type:'error',message:'pas de pair'}); },
  candidate(ws, msg) { const p = getPeer(ws); if(p) send(p, msg); },
  cmd(ws, msg)    {
    log.info(`[room:${ws._roomId}] cmd "${msg.cmd}" de ${ws._id}`);
    const p = getPeer(ws); if(p) send(p, msg);
  },
  // L'ESP32 signale un appel vers un appartement : on diffuse à toutes les apps
  // L'ESP32 signale un appel vers un appartement : on diffuse aux WS + en Push local
  ring(ws, msg)   {
    log.info(`RING vers "${msg.apt}" (room video: ${msg.room})`);
    
    // Mémoriser l'appel en cours (pour un résident qui ouvre l'app via la notif)
    pendingRings[msg.apt] = { room: msg.room, apt: msg.apt, ts: Date.now() };

    // Envoi classique par WebSocket aux applications actuellement ouvertes
    wss.clients.forEach(c => {
      if (c.readyState === WebSocket.OPEN && c !== ws) {
        send(c, { type: 'ring', apt: msg.apt, room: msg.room });
      }
    });

    // Envoi par Web Push (Apple Push Notification service) pour les applications fermées
    const payload = JSON.stringify({
      title: "Visiophone",
      body: `Quelqu'un sonne au ${msg.apt} !`,
      room: msg.room // On transmet la room pour que l'app se connecte au décrochage
    });

    pushSubscriptions.forEach(entry => {
      // On cible uniquement les smartphones configurés pour cet appartement
      if (entry.apt === msg.apt) {
        webpush.sendNotification(entry.sub, payload)
          .then(() => log.info(`[Push] Notification envoyée avec succès au ${msg.apt}`))
          .catch(err => {
            log.warn(`[Push] Échec envoi au ${msg.apt} : ${err.message}`);
            // Si le token a expiré (l'utilisateur a supprimé la PWA par exemple), on nettoie la mémoire
            if (err.statusCode === 410 || err.statusCode === 404) {
              const idx = pushSubscriptions.indexOf(entry);
              if (idx > -1) pushSubscriptions.splice(idx, 1);
              log.info('[Push] Abonnement expiré supprimé.');
            }
          });
      }
    });
  },
  // Refus d'appel : broadcast a tous (la carte le captera pour revenir a idle)
  ring_deny(ws, msg) {
    log.info(`REFUS d'appel pour "${msg.apt}"`);
    delete pendingRings[msg.apt];   // l'appel n'est plus en attente
    wss.clients.forEach(c => {
      if (c.readyState === WebSocket.OPEN && c !== ws) {
        send(c, { type: 'ring_deny', apt: msg.apt, room: msg.room });
      }
    });
  },
  // Une app déclare quel appartement elle représente (pour info/log)
  register(ws, msg) {
    ws._apt = msg.apt;
    log.info(`${ws._id} enregistré comme "${msg.apt}"`);
    // Si un appel est en cours pour cet apt (< 30s), le renvoyer au résident qui (re)vient
    const pending = pendingRings[msg.apt];
    if (pending && (Date.now() - pending.ts) < 30000) {
      log.info(`Ring en attente renvoyé à ${msg.apt} (room ${pending.room})`);
      send(ws, { type: 'ring', apt: pending.apt, room: pending.room });
    }
  },

  get_pending_ring(ws, msg) {
    const pending = pendingRings[msg.apt];
    if (pending && (Date.now() - pending.ts) < 30000) {
      log.info(`Ring en attente (re)demandé par ${msg.apt} (room ${pending.room})`);
      send(ws, { type: 'ring', apt: pending.apt, room: pending.room });
    }
  },
};

// ─── Page HTML ────────────────────────────────────────────────────────────────

const HTML_PAGE = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Doorbell</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg:        #F0F2F5;
    --surface:   #FFFFFF;
    --border:    rgba(180,190,210,0.30);
    --border-hi: rgba(30,130,230,0.45);
    --text:      #14141E;
    --muted:     #828796;
    --green:     #1EB450;
    --red:       #DC3232;
    --amber:     #FFA000;
    --blue:      #1E82E6;
    --input-bg:  #EBEEF5;
    --mono:      'Montserrat', sans-serif;
    --sans:      'Montserrat', sans-serif;
  }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--sans);
    min-height: 100dvh;
    display: grid;
    grid-template-rows: auto 1fr auto;
    grid-template-areas: "header" "main" "footer";
  }

  /* ── Header ── */
  header {
    grid-area: header;
    padding: 16px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--border);
  }
  .logo {
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .logo-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--green);
    box-shadow: 0 0 8px var(--green);
    transition: background .3s, box-shadow .3s;
  }
  .logo-dot.off  { background: var(--muted); box-shadow: none; }
  .logo-dot.warn { background: var(--amber); box-shadow: 0 0 8px var(--amber); }

  .status-bar {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 16px;
  }
  #status-text { color: var(--text); }

  /* ── Main layout ── */
  main {
    grid-area: main;
    display: grid;
    grid-template-columns: 1fr 280px;
    gap: 1px;
    background: var(--border);
    overflow: hidden;
  }

  @media (max-width: 1024px) {
    body {
      grid-template-rows: auto auto auto !important;
    }
    main {
      display: flex !important;
      flex-direction: column !important;
      overflow: visible !important;
      height: auto !important;
    }
    .video-panel {  
      width: 100%;
      min-height: 55vw;
      flex-shrink: 0;
    }
    .sidebar { 
      overflow: visible !important;
      overflow-y: visible !important;
      max-height: none !important;   
      height: auto !important;
    }
    footer { flex-wrap: wrap; gap: 8px; }

    #room-input {
        display: block !important;
        width: 100% !important;
        min-height: 44px !important;
        background: #EBEEF5 !important;
        border: 1px solid rgba(180,190,210,0.5) !important;
        color: #14141E !important;
        -webkit-text-fill-color: #14141E !important;
        font-size: 16px !important;
        padding: 11px 13px !important;
        border-radius: 10px !important;
        box-sizing: border-box !important;
        -webkit-appearance: none !important;
    }

    .sidebar > section:first-child .section-label {
        display: block !important;
        color: var(--muted) !important;
    }

    #conn-badge {
        display: inline-flex !important;
    }
}

  /* ── Video panel ── */
  .video-panel {
    background: #0A0A0F;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 360px;
  }
  #remote-video {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .video-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    background: #0A0A0F;
    color: #888;
    transition: opacity .4s;
  }
  .video-overlay.hidden { opacity: 0; pointer-events: none; }
  .video-overlay svg { opacity: 0.15; }
  .video-overlay p {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    letter-spacing: 0.08em;
  }

  /* ── Sidebar ── */
  .sidebar {
    background: var(--surface);
    display: flex;
    flex-direction: column;
    padding: 24px;
    gap: 24px;
    overflow-y: auto;
  }

  .section-label {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 8px;
  }

  /* Room join */
  .room-form { display: flex; flex-direction: column; gap: 8px; }
  input[type="text"] {
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 11px 13px;
    color: var(--text);
    font-family: var(--sans);
    font-weight: 500;
    font-size: 13px;
    outline: none;
    transition: border-color .2s;
  }
  input[type="text"]:focus { border-color: var(--border-hi); }
  input[type="text"]::placeholder { color: var(--muted); }

  /* Buttons */
  .btn {
    border: none; cursor: pointer; border-radius: 6px;
    font-family: var(--sans); font-size: 13px; font-weight: 600;
    padding: 10px 16px;
    transition: opacity .15s, transform .1s;
    letter-spacing: 0.04em;
  }
  .btn:active { transform: scale(0.97); }
  .btn:disabled { opacity: 0.35; cursor: not-allowed; }
  .btn-primary  { background: var(--blue);  color: #fff; box-shadow: 0 4px 14px rgba(30,130,230,.32); }
  .btn-danger   { background: var(--red);   color: #fff; }
  .btn-success  { background: var(--green); color: #fff; }
  .btn-ghost    { background: var(--input-bg); color: var(--text); border: 1px solid var(--border); }
  .btn-full     { width: 100%; }

  /* Pill badges */
  .badge {
    display: inline-flex; align-items: center; gap: 5px;
    font-family: var(--mono); font-size: 10px;
    padding: 3px 8px; border-radius: 100px;
    letter-spacing: 0.06em;
  }
  .badge-dot { width:6px; height:6px; border-radius:50%; }
  .badge-green { background: rgba(0,232,122,.12); color: var(--green); }
  .badge-green .badge-dot { background: var(--green); }
  .badge-red   { background: rgba(255,64,64,.12);  color: var(--red);   }
  .badge-red   .badge-dot { background: var(--red);   }
  .badge-muted { background: var(--input-bg); color: var(--muted); }
  .badge-muted .badge-dot { background: var(--muted); }

  /* Connexion state */
  #conn-badge { margin-bottom: 4px; }

  /* Door button */
  .door-btn {
    width: 100%;
    padding: 16px;
    border-radius: 14px;
    border: 1px solid var(--border);
    background: var(--surface);
    cursor: pointer;
    display: flex; align-items: center; gap: 12px;
    color: var(--text);
    box-shadow: 0 3px 14px rgba(180,190,210,.35);
    transition: border-color .2s, background .2s;
    font-family: var(--sans); font-size: 14px; font-weight: 600;
  }
  .door-btn:hover:not(:disabled) { border-color: var(--border-hi); background: var(--input-bg); }
  .door-btn:disabled { opacity: 0.3; cursor: not-allowed; }
  .door-icon {
    width: 36px; height: 36px; border-radius: 10px;
    background: rgba(30,130,230,.12);
    display: flex; align-items: center; justify-content: center;
    font-size: 18px;
    flex-shrink: 0;
  }

  /* Log console */
  #log {
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px 12px;
    font-family: var(--mono);
    font-size: 10px;
    line-height: 1.7;
    color: var(--muted);
    height: 130px;
    overflow-y: auto;
    flex-shrink: 0;
  }
  #log .log-info  { color: var(--text); }
  #log .log-ok    { color: var(--green); }
  #log .log-warn  { color: var(--amber); }
  #log .log-err   { color: var(--red); }

  /* ── Footer ── */
  footer {
    grid-area: footer;
    padding: 12px 24px;
    border-top: 1px solid var(--border);
    font-family: var(--mono);
    font-size: 10px;
    color: var(--muted);
    display: flex;
    gap: 24px;
    letter-spacing: 0.06em;
  }
  footer span { color: var(--text); }

  /* ── Ring notification ── */
  #ring-overlay {
    position: fixed; inset: 0; z-index: 100;
    background: rgba(0,0,0,.85);
    backdrop-filter: blur(6px);
    display: flex; align-items: center; justify-content: center;
    opacity: 0; pointer-events: none;
    transition: opacity .3s;
  }
  #ring-overlay.visible { opacity: 1; pointer-events: all; }
  .ring-card {
    background: var(--surface);
    border: 1px solid var(--border-hi);
    border-radius: 16px;
    padding: 36px 40px;
    text-align: center;
    display: flex; flex-direction: column; align-items: center; gap: 20px;
    width: 320px;
    animation: ringCardIn .3s cubic-bezier(.22,1,.36,1) both;
  }
  @keyframes ringCardIn { from { transform: scale(.88) translateY(20px); } to { transform: none; } }
  .ring-bell {
    width: 72px; height: 72px; border-radius: 50%;
    background: rgba(255,176,32,.1);
    border: 2px solid var(--amber);
    display: flex; align-items: center; justify-content: center;
    font-size: 32px;
    animation: ringPulse 1s ease-in-out infinite;
  }
  @keyframes ringPulse {
    0%,100% { box-shadow: 0 0 0 0 rgba(255,176,32,.4); }
    50%      { box-shadow: 0 0 0 16px rgba(255,176,32,0); }
  }
  .ring-title { font-size: 20px; font-weight: 700; }
  .ring-sub   { font-size: 13px; color: var(--muted); }
  .ring-actions { display: flex; gap: 12px; width: 100%; }
  .ring-actions .btn { flex: 1; padding: 14px; font-size: 14px; }

  /* ── Audio indicator ── */
  #audio-bar {
    display: none;
    align-items: center;
    gap: 8px;
    font-family: var(--mono);
    font-size: 10px;
    color: var(--green);
  }
  #audio-bar.active { display: flex; }
  .audio-waves { display: flex; gap: 2px; align-items: flex-end; height: 14px; }
  .audio-waves span {
    width: 3px; border-radius: 2px; background: var(--green);
    animation: wave 0.6s ease-in-out infinite;
  }
  .audio-waves span:nth-child(2) { animation-delay: .1s; }
  .audio-waves span:nth-child(3) { animation-delay: .2s; }
  .audio-waves span:nth-child(4) { animation-delay: .3s; }
  @keyframes wave {
    0%,100% { height: 3px; }
    50%      { height: 14px; }
  }
</style>
</head>
<body>

<!-- ── Header (masque cote resident) ── -->
<header style="display:none">
  <div class="logo">
    <div class="logo-dot off" id="logo-dot"></div>
    DOORBELL GOOBIE
  </div>
  <div class="status-bar">
    <div id="audio-bar">
      <div class="audio-waves">
        <span></span><span></span><span></span><span></span>
      </div>
      Audio actif
    </div>
    <div id="status-text">Déconnecté</div>
  </div>
</header>

<!-- ── Main ── -->
<main>

  <!-- Vidéo -->
  <div class="video-panel">
    <video id="remote-video" autoplay playsinline muted></video>
    <div class="video-overlay" id="video-overlay">
      <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
        <path d="M15 10l4.553-2.069A1 1 0 0121 8.87v6.26a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"/>
      </svg>
      <p id="overlay-text">EN ATTENTE DE FLUX</p>
    </div>
  </div>

  <!-- Sidebar -->
  <aside class="sidebar">

    <!-- Connexion (masque cote resident : autojoin gere tout) -->
    <section style="display:none">
      <div class="section-label">Connexion</div>
      <div id="conn-badge" class="badge badge-muted">
        <span class="badge-dot"></span> Déconnecté
      </div>
      <div class="room-form">
        <input type="text" id="room-input" placeholder="ID de la room (ex: esp_aabbcc)" value="">
        <button class="btn btn-primary btn-full" id="btn-join">Rejoindre</button>
        <button class="btn btn-ghost btn-full" id="btn-leave" disabled>Quitter</button>
      </div>
    </section>

    <!-- Caméra & Audio -->
    <section>
      <div class="section-label">Contrôles</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button class="door-btn" id="btn-door" disabled>
          <div class="door-icon"></div>
          <div>
            <div>Ouvrir la porte</div>
            <div style="font-size:11px;font-weight:400;color:var(--muted);margin-top:2px">Envoie cmd open_door</div>
          </div>
        </button>
        <button class="btn btn-ghost btn-full" id="btn-mute" disabled> Micro activé</button>
        <button class="btn btn-primary btn-full" id="btn-gencode" disabled> Générer un code d'accès</button>
        <div id="gencode-display" style="display:none;text-align:center;font-size:34px;font-weight:700;letter-spacing:10px;padding:14px;background:var(--input-bg);border-radius:12px;margin-top:8px"></div>
        <button class="btn btn-danger btn-full" id="btn-hangup" disabled> Raccrocher</button>
      </div>
    </section>

    <!-- Log (masque cote resident, conserve pour le JS) -->
    <section style="display:none">
      <div class="section-label">Journal</div>
      <div id="log"></div>
    </section>

  </aside>
</main>

<!-- ── Footer (masque cote resident) ── -->
<footer style="display:none">
  <div>WS <span id="ws-url">—</span></div>
  <div>Room <span id="footer-room">—</span></div>
  <div>Pairs <span id="footer-peers">0</span></div>
</footer>

<!-- ── Ring overlay ── -->
<div id="ring-overlay">
  <div class="ring-card">
    <div class="ring-bell"></div>
    <div class="ring-title">Quelqu'un à la porte</div>
    <div class="ring-sub">L'ESP32 sonne — accepter l'appel ?</div>
    <div class="ring-actions">
      <button class="btn btn-danger"  id="btn-deny">  Refuser  </button>
      <button class="btn btn-success" id="btn-accept"> Accepter </button>
    </div>
  </div>
</div>
<audio id="remote-audio" autoplay playsinline></audio>
<script>
// ─── État ──────────────────────────────────────────────────────────────────

const state = {
  ws:        null,
  pc:        null,
  room:      null,
  peers:     0,
  micOn:     true,
  localStream: null,
  connected: false,   // WebRTC connecté
  wsOpen:    false,
};

// ─── Éléments DOM ──────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const els = {
  roomInput:   $('room-input'),
  btnJoin:     $('btn-join'),
  btnLeave:    $('btn-leave'),
  btnDoor:     $('btn-door'),
  btnGencode:  $('btn-gencode'),
  btnHangup:   $('btn-hangup'),
  gencodeDisplay: $('gencode-display'),
  btnMute:     $('btn-mute'),
  btnAccept:   $('btn-accept'),
  btnDeny:     $('btn-deny'),
  logEl:       $('log'),
  statusText:  $('status-text'),
  logoDot:     $('logo-dot'),
  connBadge:   $('conn-badge'),
  videoEl:     $('remote-video'),
  videoOverlay:$('video-overlay'),
  overlayText: $('overlay-text'),
  ringOverlay: $('ring-overlay'),
  audioBar:    $('audio-bar'),
  wsUrl:       $('ws-url'),
  footerRoom:  $('footer-room'),
  footerPeers: $('footer-peers'),
  audioEl: $('remote-audio'),
};

// ─── Logger UI ─────────────────────────────────────────────────────────────

function log(msg, level = 'info') {
  const el  = document.createElement('div');
  const ts  = new Date().toLocaleTimeString('fr-FR', { hour12: false });
  el.className = 'log-' + level;
  el.textContent = ts + '  ' + msg;
  els.logEl.appendChild(el);
  els.logEl.scrollTop = els.logEl.scrollHeight;
  if (els.logEl.children.length > 200) els.logEl.removeChild(els.logEl.firstChild);
}

// ─── UI helpers ────────────────────────────────────────────────────────────

function setStatus(text, dotClass = 'off') {
  els.statusText.textContent = text;
  els.logoDot.className = 'logo-dot ' + dotClass;
}

function setConnBadge(label, cls) {
  els.connBadge.className = 'badge ' + cls;
  els.connBadge.innerHTML = '<span class="badge-dot"></span> ' + label;
}

function updateFooter() {
  els.wsUrl.textContent       = state.wsOpen ? location.host : '—';
  els.footerRoom.textContent  = state.room   || '—';
  els.footerPeers.textContent = state.peers;
}

function setVideoVisible(visible) {
  els.videoOverlay.classList.toggle('hidden', visible);
  if (!visible) els.overlayText.textContent = 'EN ATTENTE DE FLUX';
}

// ─── WebSocket ─────────────────────────────────────────────────────────────

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url   = proto + '//' + location.host;
  state.ws    = new WebSocket(url);

  state.ws.onopen = () => {
    state.wsOpen = true;
    log('WebSocket connecté au serveur', 'ok');
    setStatus('Connecté au serveur', 'warn');
    setConnBadge('Serveur OK — en attente de room', 'badge-muted');
    updateFooter();
    // Auto-join : si la page a ete ouverte avec ?room=...&autojoin=1
    if (_autoJoin && _autoRoom) {
      log('Auto-join room ' + _autoRoom, 'ok');
      wsSend({ type: 'join', room: _autoRoom });
    }
  };

  state.ws.onclose = () => {
    state.wsOpen = false;
    log('WebSocket fermé — tentative de reconnexion dans 3s', 'warn');
    setStatus('Déconnecté', 'off');
    setConnBadge('Déconnecté', 'badge-muted');
    cleanupPeer();
    updateFooter();
    setTimeout(connectWS, 3000);
  };

  state.ws.onerror = err => {
    log('Erreur WebSocket', 'err');
  };

  state.ws.onmessage = ({ data }) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    handleSignaling(msg);
  };
}

function wsSend(obj) {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
  }
}

// ─── Signalisation ─────────────────────────────────────────────────────────

async function handleSignaling(msg) {
  switch (msg.type) {

    case 'joined':
      state.room  = msg.room;
      state.peers = msg.peers;
      log('Room rejointe : ' + msg.room + ' (' + msg.peers + ' pair(s))', 'ok');
      setStatus('Dans la room : ' + msg.room, 'warn');
      setConnBadge('Room jointe — attente ESP32', 'badge-muted');
      els.btnJoin.disabled  = true;
      els.btnLeave.disabled = false;
      updateFooter();
      // Auto-accept : si on a rejoint via le bouton Repondre de l'app residente,
      // on declenche l'appel cote ESP32 (qui n'envoie son offre qu'apres ACCEPT_CALL)
      if (_autoJoin) {
        log('Auto-accept : envoi ACCEPT_CALL', 'ok');
        wsSend({ type: 'cmd', cmd: 'ACCEPT_CALL' });
      }
      break;

    case 'peer_joined':
      state.peers++;
      log('ESP32 a rejoint la room', 'ok');
      setConnBadge('ESP32 présent', 'badge-green');
      updateFooter();
      // Initialiser WebRTC si pas encore fait
      if (!state.pc) await setupPeerConnection();
      break;

    case 'peer_left':
      state.peers = Math.max(0, state.peers - 1);
      log('ESP32 a quitté la room', 'warn');
      setConnBadge('ESP32 absent', 'badge-muted');
      cleanupPeer();
      updateFooter();
      break;

    case 'offer':
      log('SDP offer reçu de l ESP32');
      if (!state.pc) await setupPeerConnection();
      await state.pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      const answer = await state.pc.createAnswer();
      await state.pc.setLocalDescription(answer);
      wsSend({ type: 'answer', sdp: answer.sdp });
      log('SDP answer envoyé');
      break;

    case 'answer':
      log('SDP answer reçu');
      if (state.pc) await state.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      break;

    case 'candidate':
      if (state.pc && msg.candidate) {
        try { await state.pc.addIceCandidate(msg.candidate); }
        catch(e) { log('ICE candidate ignoré : ' + e.message, 'warn'); }
      }
      break;

    case 'cmd':
      handleCmd(msg.cmd);
      break;

    case 'full':
      log('Room pleine — impossible de rejoindre', 'err');
      break;

    case 'error':
      log('Erreur serveur : ' + msg.message, 'err');
      break;

    case 'pong':
      break; // keepalive silencieux
  }
}

// ─── WebRTC ────────────────────────────────────────────────────────────────

async function setupPeerConnection() {
  cleanupPeer();
  log('Initialisation RTCPeerConnection...');

  state.pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'turn:global.relay.metered.ca:443',
        username: '211130c327e898956c259e87',
        credential: 'QCs25A2QaURaqOSo' },
      { urls: 'turn:global.relay.metered.ca:443?transport=tcp',
        username: '211130c327e898956c259e87',
        credential: 'QCs25A2QaURaqOSo' },
      { urls: 'turns:global.relay.metered.ca:443?transport=tcp',
        username: '211130c327e898956c259e87',
        credential: 'QCs25A2QaURaqOSo' },
    ],
  });

  // Micro local
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({ 
      audio: { 
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 16000,
      },
      video: false
    });

    state.localStream.getTracks().forEach(t => state.pc.addTrack(t, state.localStream));
    log('Micro local activé', 'ok');
  } catch(e) {
    log('Micro indisponible : ' + e.message, 'warn');
  }

  // Flux entrant (vidéo + audio ESP32)
  state.pc.ontrack = ({ streams, track }) => {
    if (!streams[0]) return;
    if (track.kind === 'video') {
        els.videoEl.srcObject = streams[0];
        // Jitter buffer court : démarrage plus rapide, moins de latence
        const recv = state.pc.getReceivers().find(r => r.track && r.track.kind === 'video');
        if (recv && 'jitterBufferTarget' in recv) { try { recv.jitterBufferTarget = 400; } catch(e){} }
        els.videoEl.play().catch(e => log('Lecture vidéo: ' + e.message, 'warn'));
        setVideoVisible(true);
        log('Flux vidéo reçu', 'ok');
    }
    if (track.kind === 'audio') {
        els.audioEl.srcObject = streams[0];
        log('Flux audio reçu', 'ok');
        els.audioBar.classList.add('active');
    }
};


  // Candidats ICE locaux → relayer au serveur
  state.pc.onicecandidate = ({ candidate }) => {
    if (candidate) wsSend({ type: 'candidate', candidate: candidate.toJSON() });
  };

  state.pc.oniceconnectionstatechange = () => {
    const s = state.pc?.iceConnectionState;
    log('ICE : ' + s, s === 'connected' || s === 'completed' ? 'ok' : 'info');
    if (s === 'connected' || s === 'completed') {
      state.connected = true;
      setStatus('Connecté — P2P actif', '');
      els.logoDot.className = 'logo-dot';
      setConnBadge('WebRTC P2P actif', 'badge-green');
      els.btnDoor.disabled = false;
      els.btnGencode.disabled = false;
      els.btnHangup.disabled = false;
      els.btnMute.disabled = false;
    }
    if (s === 'disconnected' || s === 'failed') {
      state.connected = false;
      setStatus('P2P perdu', 'warn');
      els.btnDoor.disabled = true;
  els.btnGencode.disabled = true;
  els.btnHangup.disabled = true;
      els.btnMute.disabled = true;
      setVideoVisible(false);
      els.audioBar.classList.remove('active');
    }
  };
}

function cleanupPeer() {
  if (state.localStream) {
    state.localStream.getTracks().forEach(t => t.stop());
    state.localStream = null;
  }
  if (state.pc) {
    state.pc.close();
    state.pc = null;
  }
  state.connected = false;
  els.videoEl.srcObject = null;
  setVideoVisible(false);
  els.audioBar.classList.remove('active');
  els.btnDoor.disabled = true;
  els.btnGencode.disabled = true;
  els.btnHangup.disabled = true;
  els.btnMute.disabled = true;
}

// ─── Commandes custom ──────────────────────────────────────────────────────

function handleCmd(cmd) {
  switch (cmd.toLowerCase()) {
    case 'ring':
      log(' Sonnette !', 'warn');
      showRingOverlay();
      break;
    case 'door_opened':
      log(' Porte ouverte confirmée', 'ok');
      playOpenChime();
      break;
    default:
      log('Commande reçue : ' + cmd);
  }
}

function playOpenChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const beep = (freq, start, dur) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = freq; osc.type = 'sine';
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(0.35, ctx.currentTime + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + dur);
    };
    beep(660, 0, 0.18);
    beep(990, 0.16, 0.28);
  } catch(e) {}
}
function playRingOverlay() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const playBeep = (freq, start, duration) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.3, ctx.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + duration);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + duration);
    };
    playBeep(880, 0, 0.4);
    playBeep(660, 0.45, 0.6);
    playBeep(880, 0, 0.4);
    playBeep(660, 0.45, 0.6);
    playBeep(880, 0, 0.4);
    playBeep(660, 0.45, 0.6);

  } catch(e) {
    log('Audio indisponible : ' + e.message, 'warn');
  }
}
function showRingOverlay() {
  els.ringOverlay.classList.add('visible');
  playRingOverlay();
  // Auto-fermeture après 30s sans réponse
  clearTimeout(window._ringTimer);
  window._ringTimer = setTimeout(() => {
    els.ringOverlay.classList.remove('visible');
    log('Sonnette ignorée (timeout)', 'warn');
  }, 30_000);
}

// ─── Event listeners ───────────────────────────────────────────────────────

els.btnJoin.onclick = () => {
  const room = els.roomInput.value.trim();
  if (!room) { log('Entrez un ID de room', 'warn'); return; }
  wsSend({ type: 'join', room });
};

els.btnLeave.onclick = () => {
  wsSend({ type: 'leave' });
  state.room  = null;
  state.peers = 0;

  cleanupPeer();
  setStatus('Connecté au serveur', 'warn');
  setConnBadge('Hors room', 'badge-muted');
  els.btnJoin.disabled  = false;
  els.btnLeave.disabled = true;
  updateFooter();
  log('Room quittée');
};

els.btnDoor.onclick = () => {
  wsSend({ type: 'cmd', cmd: 'OPEN_DOOR' });
  log('Commande open_door envoyée');
};
els.btnHangup.onclick = () => {
  wsSend({ type: 'leave' });
  state.room  = null;
  state.peers = 0;
  cleanupPeer();
  log('Appel raccroche');
};
els.btnGencode.onclick = () => {
  const code = String(Math.floor(1000 + Math.random() * 9000));
  els.gencodeDisplay.textContent = code;
  els.gencodeDisplay.style.display = 'block';
  wsSend({ type: 'cmd', cmd: 'SETCODE:' + code });
  log('Code d acces genere : ' + code, 'ok');
};

els.btnMute.onclick = () => {
  state.micOn = !state.micOn;
  if (state.localStream) {
    state.localStream.getAudioTracks().forEach(t => { t.enabled = state.micOn; });
  }
  els.btnMute.textContent = state.micOn ? ' Micro activé' : ' Micro coupé';
  log(state.micOn ? 'Micro activé' : 'Micro coupé');
};

els.btnAccept.onclick = () => {
  clearTimeout(window._ringTimer);
  els.ringOverlay.classList.remove('visible');
  wsSend({ type: 'cmd', cmd: 'ACCEPT_CALL' });
  log('Appel accepté', 'ok');
};

els.btnDeny.onclick = () => {
  clearTimeout(window._ringTimer);
  els.ringOverlay.classList.remove('visible');
  wsSend({ type: 'cmd', cmd: 'DENY_CALL' });
  log('Appel refusé');
};

// Entrée clavier dans le champ room
els.roomInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') els.btnJoin.click();
});


// ─── Démarrage ─────────────────────────────────────────────────────────────

// Auto-join : lecture des parametres d'URL (ouvert depuis l'app residente)
const _urlParams = new URLSearchParams(location.search);
const _autoRoom  = _urlParams.get('room');
const _autoJoin  = _urlParams.get('autojoin') === '1';
if (_autoRoom) els.roomInput.value = _autoRoom;
connectWS();
log('Interface démarrée — entrez un ID de room pour commencer');
</script>
</body>
</html>`;

// ─── Serveur HTTP ────────────────────────────────────────────────────────────

const httpServer = http.createServer((req, res) => {

  // Chemin sans query string (pour matcher /legacy?room=...&autojoin=1)
  const pathname = req.url.split('?')[0];
  // 1. Permettre à l'iPhone de récupérer la clé publique pour chiffrer l'abonnement
  if (pathname === '/api/vapid') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ publicKey: VAPID_KEYS.publicKey }));
  }

  // 2. Recevoir et sauvegarder la clé d'abonnement (le token de push) de l'iPhone
  if (req.method === 'POST' && pathname === '/api/subscribe') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.subscription && data.apt) {
          // Éviter d'enregistrer deux fois le même appareil
          const exists = pushSubscriptions.find(s => s.sub.endpoint === data.subscription.endpoint);
          if (!exists) {
            pushSubscriptions.push({ apt: data.apt, sub: data.subscription });
            log.info(`[Push] Nouvel appareil enregistré pour l'appartement : ${data.apt}`);
          } else {
            exists.apt = data.apt; // Mise à jour de l'appartement si changé
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ status: 'ok' }));
        }
      } catch (e) {
        log.error('Erreur inscription push:', e.message);
      }
      res.writeHead(400);
      return res.end('Bad Request');
    });
    return;
  }
  // Ancienne page WebRTC (utilisée dans l'iframe Caméra)
  if (pathname === '/legacy') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(HTML_PAGE);
  }
  // Nouvelle app multi-pages : racine -> public/index.html
  if (pathname === '/') {
    res.writeHead(302, { 'Location': '/index.html' });
    return res.end();
  }

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok', rooms: rooms.size,
      connections: totalConnections, messages: totalMessages,
      uptime: Math.floor(process.uptime()),
    }));
  }

  if (pathname === '/rooms') {
    const data = {};
    for (const [id, room] of rooms) data[id] = { peers: room.size };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(data, null, 2));
  }

  // Fichiers statiques depuis public/
  const PUBLIC_DIR = path.join(__dirname, 'public');
  const MIME = { '.html':'text/html; charset=utf-8', '.css':'text/css', '.js':'text/javascript',
                 '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml',
                 '.ico':'image/x-icon', '.webmanifest':'application/manifest+json' };
  const safe = path.normalize(req.url.split('?')[0]).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safe);
  if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    return res.end(fs.readFileSync(filePath));
  }

  res.writeHead(404); res.end('Not found');
});

// ─── WebSocket ───────────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  const ip   = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  ws._id     = `client-${++totalConnections}`;
  ws._roomId = null;
  ws._alive  = true;
  log.info(`${ws._id} connecté depuis ${ip}`);

  ws.on('message', raw => {
    totalMessages++;
    let msg;
    try { msg = JSON.parse(raw); } catch { return send(ws, { type: 'error', message: 'JSON invalide' }); }
    if (!msg.type) return send(ws, { type: 'error', message: 'champ "type" manquant' });
    log.debug(`${ws._id} →`, JSON.stringify(msg).slice(0, 120));
    const h = handlers[msg.type];
    if (h) h(ws, msg);
    else { log.warn(`type inconnu : "${msg.type}"`); send(ws, { type: 'error', message: `type inconnu : ${msg.type}` }); }
  });

  ws.on('close', code => { log.info(`${ws._id} déconnecté (code ${code})`); leaveRoom(ws); });
  ws.on('error', err  => { log.error(`${ws._id} : ${err.message}`); });
  ws.on('pong',  ()   => { ws._alive = true; });
});

const pingInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws._alive) { log.warn(`${ws._id} timeout — fermeture forcée`); leaveRoom(ws); return ws.terminate(); }
    ws._alive = false; ws.ping();
  });
}, CONFIG.PING_INTERVAL_MS);

wss.on('close', () => clearInterval(pingInterval));

// ─── Démarrage ───────────────────────────────────────────────────────────────

httpServer.listen(CONFIG.PORT, () => {
  log.info(`Serveur démarré sur http://0.0.0.0:${CONFIG.PORT}`);
  log.info(`Interface web : http://localhost:${CONFIG.PORT}/`);
  log.info(`WebSocket     : ws://localhost:${CONFIG.PORT}/`);
});

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

function shutdown(sig) {
  log.info(`${sig} — arrêt propre`);
  clearInterval(pingInterval);
  wss.clients.forEach(ws => { send(ws, { type: 'error', message: 'Serveur arrêté' }); ws.terminate(); });
  httpServer.close(() => { log.info('Arrêté.'); process.exit(0); });
}
