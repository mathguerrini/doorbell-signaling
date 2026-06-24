(function(){
  'use strict';

  // Liste des appartements (doit correspondre a display_ui.c cote ESP32)
  var APARTMENTS = ['Apt 1A','Apt 1B','Apt 2A','Apt 2B','Apt 3A','Apt 3B','Apt 4A','Apt 4B'];

  // ─── Etat ───
  var myApt = localStorage.getItem('myApt') || null;
  var pendingRoom = null;  // room video recue dans le ring

  // Bip de confirmation "porte ouverte"
  function playOpenChime(){
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var beep = function(freq, start, dur){
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
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
    } catch(e){}
  }

  // ─── Elements ───
  var $ = function(id){ return document.getElementById(id); };
  var aptName   = $('apt-name');
  var aptBanner = $('apt-banner');
  var aptModal  = $('apt-modal');
  var aptList   = $('apt-list');
  var ringOverlay = $('ring-overlay');
  var ringSub   = $('ring-sub');

  // ─── WebSocket persistant ───
  var ws = null, wsReady = false;
  function connectWS(){
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(proto + '://' + location.host);
    ws.onopen = function(){
      wsReady = true;
      if (myApt) ws.send(JSON.stringify({ type:'register', apt: myApt }));
    };
    ws.onclose = function(){ wsReady = false; setTimeout(connectWS, 3000); };
    ws.onmessage = function(ev){
      var msg; try { msg = JSON.parse(ev.data); } catch(e){ return; }
      if (msg.type === 'ring') onRing(msg);
    };
  }
  connectWS();

  // ─── Appel entrant ───
  function onRing(msg){
    // Est-ce pour moi ?
    if (!myApt || msg.apt !== myApt) return;
    pendingRoom = msg.room || null;
    ringSub.textContent = 'Appartement ' + msg.apt;
    ringOverlay.classList.remove('hidden');
    // Vibration si supportee
    if (navigator.vibrate) navigator.vibrate([400,200,400]);
  }

  $('ring-deny').addEventListener('click', function(){
    ringOverlay.classList.add('hidden');
    if (navigator.vibrate) navigator.vibrate(0);
    // Prevenir la carte que l'appel est refuse (broadcast)
    if (ws && wsReady) ws.send(JSON.stringify({ type:'ring_deny', apt: myApt, room: pendingRoom }));
  });

  $('ring-accept').addEventListener('click', function(){
    ringOverlay.classList.add('hidden');
    if (navigator.vibrate) navigator.vibrate(0);
    // Basculer vers l'onglet Camera pour repondre
    var camTab = document.querySelector('.tab[data-page="camera"]');
    if (camTab) camTab.click();
    // Transmettre la room video a l'iframe camera (etape suivante)
    var frame = $('cam-frame');
    if (frame && pendingRoom) {
      // On rechargera l'iframe avec la room en parametre a l'etape WebRTC
      frame.src = '/legacy?room=' + encodeURIComponent(pendingRoom) + '&autojoin=1';
    }
  });

  // ─── Choix de l'appartement ───
  // Etage deduit du nom d'appartement (Apt 1A -> Rez-de-chaussee, 2x -> 1er, etc.)
  function floorOf(apt){
    if (!apt) return '\u2014';
    var m = apt.match(/(\d)/);
    if (!m) return '\u2014';
    var n = parseInt(m[1], 10);
    if (n === 1) return 'Rez-de-chaussee';
    return (n - 1) + (n - 1 === 1 ? 'er etage' : 'eme etage');
  }
  function renderAptName(){
    aptName.textContent = myApt || 'non defini';
    var ha = document.getElementById('home-apt');
    var hf = document.getElementById('home-floor');
    if (ha) ha.textContent = myApt || 'non defini';
    if (hf) hf.textContent = floorOf(myApt);
  }
  function openAptModal(){
    aptList.innerHTML = '';
    APARTMENTS.forEach(function(apt){
      var b = document.createElement('button');
      b.textContent = apt;
      b.addEventListener('click', function(){
        myApt = apt;
        localStorage.setItem('myApt', apt);
        renderAptName();
        aptModal.classList.add('hidden');
        if (wsReady) ws.send(JSON.stringify({ type:'register', apt: myApt }));
      });
      aptList.appendChild(b);
    });
    aptModal.classList.remove('hidden');
  }
  $('apt-change').addEventListener('click', openAptModal);
  renderAptName();
  if (!myApt) openAptModal();  // premier lancement : demander l'appartement

  // ─── Generer un code (local) ───
  var btnGen = $('btn-gen-code');
  var codeDisplay = $('code-display');
  var codeTimeout = null;
  if (btnGen){
    btnGen.addEventListener('click', function(){
      var code = String(Math.floor(1000 + Math.random()*9000));
      codeDisplay.textContent = code;
      codeDisplay.classList.remove('hidden');
      btnGen.textContent = 'Nouveau code';
      if (codeTimeout) clearTimeout(codeTimeout);
      codeTimeout = setTimeout(function(){
        codeDisplay.classList.add('hidden');
        codeDisplay.textContent = '';
        btnGen.textContent = 'Generer un code';
      }, 300000);
    });
  }

  // ─── Ouvrir le portail ───
  var btnUnlock = $('btn-unlock');
  if (btnUnlock){
    btnUnlock.addEventListener('click', function(){
      if (!wsReady){ alert('Connexion en cours, reessayez.'); return; }
      ws.send(JSON.stringify({ type:'cmd', cmd:'OPEN_DOOR' }));
      playOpenChime();
      var t1 = btnUnlock.querySelector('.t1');
      var t2 = btnUnlock.querySelector('.t2');
      var ic = btnUnlock.querySelector('.lock-ic');
      btnUnlock.classList.add('open');
      if (ic) ic.innerHTML = '&#128275;';
      if (t1) t1.textContent = 'Portail ouvert !';
      if (t2) t2.textContent = 'Acces accorde';
      setTimeout(function(){
        btnUnlock.classList.remove('open');
        if (ic) ic.innerHTML = '&#128274;';
        if (t1) t1.textContent = 'Deverrouiller le portail';
        if (t2) t2.textContent = 'Appuyez pour ouvrir';
      }, 2500);
    });
  }

// ─── Gestion et Diagnostic des Notifications Push (Spécial iPhone) ───
  function registerPushNotification() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      alert("⚠️ Erreur : Les notifications ne sont pas supportées. Vérifiez que vous avez bien lancé l'application depuis l'ÉCRAN D'ACCUEIL et non depuis Safari !");
      return;
    }
    if (!myApt) {
      alert("⚠️ Erreur : Veuillez d'abord sélectionner un appartement dans l'application.");
      return;
    }

    alert("🚀 Étape 1 : Demande de permission à l'iPhone...");
    
    Notification.requestPermission().then(function(permission) {
      alert("📋 Permission accordée par l'utilisateur ? " + permission);
      if (permission !== 'granted') return;

      alert("🌐 Étape 2 : Récupération de la clé VAPID depuis Render...");
      
      fetch('/api/vapid')
        .then(res => {
          if (!res.ok) throw new Error("Le serveur Render a renvoyé une erreur " + res.status);
          return res.json();
        })
        .then(config => {
          alert("🔑 Clé VAPID reçue avec succès !");
          if (!config.publicKey) {
            alert("⚠️ Erreur : La clé publique reçue est vide.");
            return;
          }

          // Conversion de la clé VAPID
          const padding = '='.repeat((4 - config.publicKey.length % 4) % 4);
          const base64 = (config.publicKey + padding).replace(/\-/g, '+').replace(/_/g, '/');
          const rawData = window.atob(base64);
          const outputArray = new Uint8Array(rawData.length);
          for (let i = 0; i < rawData.length; ++i) { outputArray[i] = rawData.charCodeAt(i); }

          alert("📱 Étape 3 : Création de l'abonnement auprès d'Apple Push (APNs)...");
          
          return navigator.serviceWorker.ready.then(function(reg) {
            return reg.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: outputArray
            });
          });
        })
        .then(function(sub) {
          if (!sub) {
            alert("⚠️ Échec : Aucun identifiant de souscription n'a été généré.");
            return;
          }
          
          alert("📡 Étape 4 : Envoi du token de l'iPhone à ton serveur Render...");
          
          return fetch('/api/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscription: sub, apt: myApt })
          });
        })
        .then(res => {
          if (!res.ok) throw new Error("Le serveur Render a refusé l'enregistrement HTTP " + res.status);
          alert("🎉 SUCCÈS TOTAL ! Votre iPhone est lié à l'appartement " + myApt + ". Vous pouvez fermer l'app et tester la sonnette !");
        })
        .catch(err => {
          alert('❌ ERREUR CRITIQUE : ' + err.message);
          console.error(err);
        });
    });
  }

  // Activer le Service Worker et lier le bouton d'activation
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function() {
      navigator.serviceWorker.register('/sw.js').then(function() {
        console.log("Service Worker enregistré !");
        
        // Utilise ton helper '$' déjà défini plus haut
        var btnPush = $('btn-activate-push');
        if (btnPush) {
          btnPush.addEventListener('click', function() {
            registerPushNotification();
          });
        }
      });
    });
  }

  // ─── Intercepter le clic de notification et décrocher automatiquement ───
  var urlParams = new URLSearchParams(window.location.search);
  var roomParam = urlParams.get('room');
  var actionParam = urlParams.get('action');
  
  if (roomParam && actionParam === 'accept') {
    // 1. Ouvrir l'onglet Caméra
    var camTab = document.querySelector('.tab[data-page="camera"]');
    if (camTab) camTab.click();
    
    // 2. Brancher l'iframe sur la bonne room vidéo
    var frame = $('cam-frame');
    if (frame) {
      frame.src = 'https://' + window.location.host + '/legacy?room=' + encodeURIComponent(roomParam) + '&autojoin=1';
    }
  }
})();
