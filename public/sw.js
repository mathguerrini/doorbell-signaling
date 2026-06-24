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
    icon: '/icon.svg',
    badge: '/icon.svg',
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
  event.notification.close(); // Ferme la notification
  
  const room = event.notification.data ? event.notification.data.room : '';
  
  // 1. Si l'utilisateur clique sur "Refuser"
  if (event.action === 'deny') {
    console.log("L'utilisateur a refusé l'appel.");
    return; // On s'arrête là, la notification se ferme
  }

  // 2. Si l'utilisateur clique sur "Répondre" OU directement sur la bannière
  // On ajoute un paramètre &action=accept pour dire à home.js de brancher la caméra direct !
  const urlToOpen = room ? `/?room=${encodeURIComponent(room)}&action=accept` : '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // Si l'app est déjà ouverte en tâche de fond, on la passe au premier plan
      for (let client of windowClients) {
        if (client.url.includes(location.origin) && 'focus' in client) {
          return client.focus().then(() => client.navigate(urlToOpen));
        }
      }
      // Sinon, on ouvre l'application proprement
      if (clients.openWindow) return clients.openWindow(urlToOpen);
    })
  );
});