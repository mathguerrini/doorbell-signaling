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
  
  if (event.action === 'deny') {
    console.log("L'utilisateur a refusé l'appel.");
    return;
  }

  // On cible explicitement /index.html pour correspondre au manifest.json de l'iPhone
  const urlToOpen = room ? `/index.html?room=${encodeURIComponent(room)}&action=accept` : '/index.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // 1. Si l'application est déjà ouverte en tâche de fond
      for (let client of windowClients) {
        if (client.url.includes(location.origin) && 'focus' in client) {
          return client.focus().then(() => {
            // Appels de diagnostic direct vers l'application (Infaillible sur iOS)
            if ('postMessage' in client) {
              client.postMessage({
                type: 'NOTIFICATION_ACCEPT',
                room: room
              });
            }
          });
        }
      }
      // 2. Si l'application était complètement fermée, on l'ouvre proprement
      if (clients.openWindow) return clients.openWindow(urlToOpen);
    })
  );
});