// sw.js - Gestionnaire de notifications avec boutons de décrochage
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));

self.addEventListener('push', (event) => {
  let data = { title: "Visiophone", body: "Quelqu'un sonne à la porte !", room: "" };
  
  if (event.data) {
    try { data = event.data.json(); } catch(e) { data.body = event.data.text(); }
  }

  const options = {
    body: data.body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: 'visiophone-ring',
    requireInteraction: true, // Reste à l'écran tant qu'on n'interagit pas
    data: { room: data.room },
    vibrate: [500, 200, 500, 200, 500],
    
    // ─── ICI ON AJOUTE LES BOUTONS NATIFS POUR IPHONE ───
    actions: [
      { action: 'accept', title: '📞 Répondre' },
      { action: 'deny', title: '❌ Refuser' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// Action quand l'utilisateur interagit avec la notification ou les boutons
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  // Refus depuis la notif : on ne fait rien (optionnel : prévenir le serveur)
  if (event.action === 'deny') {
    return;
  }

  // Dans TOUS les autres cas (tap sur le corps OU bouton Répondre) :
  // on ouvre/ramène l'app, et on lui demande d'afficher le pop-up.
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // App déjà ouverte (premier plan ou arrière-plan) → focus + signal "afficher le ring"
      for (let client of windowClients) {
        if (client.url.includes(location.origin) && 'focus' in client) {
          return client.focus().then(() => {
            client.postMessage({ type: 'SHOW_RING' }); // demande d'afficher le pop-up
          });
        }
      }
      // App fermée → on l'ouvre ; home.js demandera le ring au chargement
      if (clients.openWindow) return clients.openWindow('/index.html');
    })
  );
});
// Handler fetch minimal — requis pour que le navigateur considère le site
// comme une vraie PWA installable (WebAPK) et non un simple raccourci.
self.addEventListener('fetch', (event) => {
  // Pass-through : on laisse le réseau gérer, mais la présence du handler
  // rend la PWA installable.
  return;
});
