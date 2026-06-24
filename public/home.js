(function(){
  'use strict';

  // Liste des appartements (doit correspondre a display_ui.c cote ESP32)
  var APARTMENTS = ['Apt 1A','Apt 1B','Apt 2A','Apt 2B','Apt 3A','Apt 3B','Apt 4A','Apt 4B'];

  // ─── Etat ───
  var myApt = localStorage.getItem('myApt') || null;
  var pendingRoom = null;  // room video recue dans le ring
  var activeCallRoom = null; // SÉCURITÉ : stocke la room en cours pour bloquer les popups intrusifs

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
    if (!myApt || msg.apt !== myApt) return;

    // 🛡️ VERROU DE SÉCURITÉ : Si on est déjà en train de regarder cette caméra via l'auto-décrochage,
    // on ignore complètement le signal de sonnette pour éviter que le pop-up ne revienne à l'écran.
    if (activeCallRoom === msg.room) return;

    pendingRoom = msg.room || null;
    ringSub.textContent = 'Appartement ' + msg.apt;
    ringOverlay.classList.remove('hidden');
    if (navigator.vibrate) navigator.vibrate([400,200,400]);
  }

  $('ring-deny').addEventListener('click', function(){
    ringOverlay.classList.add('hidden');
    activeCallRoom = null;
    if (navigator.vibrate) navigator.vibrate(0);
    if (ws && wsReady) ws.send(JSON.stringify({ type:'ring_deny', apt: myApt, room: pendingRoom }));
  });

  $('ring-accept').addEventListener('click', function(){
    ringOverlay.classList.add('hidden');
    if (navigator.vibrate) navigator.vibrate(0);
    autoAcceptCall(pendingRoom);
  });

  // ─── Fonction d'auto-décrochage unifiée ───
  function autoAcceptCall(room) {
    if (!room) return;
    
    // Activer le verrou
    activeCallRoom = room;

    // Fermer le pop-up s'il est ouvert
    if (ringOverlay) ringOverlay.classList.add('hidden');

    // 1. Basculer visuellement sur l'onglet Caméra
    var camTab = document.querySelector('.tab[data-page="camera"]');
    var allTabs = document.querySelectorAll('.tab');
    var allPages = document.querySelectorAll('.page');
    
    if (camTab) {
      allTabs.forEach(function(t) { t.classList.toggle('active', t === camTab); });
      allPages.forEach(function(p) { p.classList.toggle('active', p.id === 'page-camera'); });
    }
    
    // 2. Brancher l'iframe WebRTC immédiatement
    var frame = $('cam-frame');
    if (frame) {
      frame.src = '/legacy?room=' + encodeURIComponent(room) + '&autojoin=1';
    }
  }

  // ─── Choix de l'appartement ───
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
  if (!myApt) openAptModal();

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

  // ─── ⚡ RÉCEPTION DU SIGNAL DE DÉCROCHAGE (SPÉCIAL IPHONE) ───

  // Cas n°1 : L'application était en arrière-plan (Capture du postMessage du SW)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function(event) {
      if (event.data && event.data.type === 'NOTIFICATION_ACCEPT') {
        autoAcceptCall(event.data.room);
      }
    });
  }

  // Cas n°2 : L'application était complètement fermée (Lecture des paramètres d'URL au démarrage)
  var urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('action') === 'accept') {
    autoAcceptCall(urlParams.get('room'));
  }

})();