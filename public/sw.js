// sw.js - Gestionnaire de notifications en arrière-plan
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));

// 1. Écouter l'événement "sonnerie" envoyé par Render
self.addEventListener('push', (event) => {
  let data = { title: "Visiophone", body: "Quelqu'un sonne à la porte !", room: "" };
  
  if (event.data) {
    try { data = event.data.json(); } catch(e) { data.body = event.data.text(); }
  }

  const options = {
    body: data.body,
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: 'visiophone-ring', // Évite d'empiler 50 notifications si ça insiste
    requireInteraction: true, // La notification reste à l'écran tant qu'on ne clique pas
    data: { room: data.room }, // On stocke l'ID de la session WebRTC
    vibrate: [500, 200, 500, 200, 500] // Vibration style sonnerie
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// 2. Action quand l'utilisateur clique sur la notification
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const room = event.notification.data ? event.notification.data.room : '';
  
  // URL à ouvrir : on passe la room en paramètre à l'application principale
  const urlToOpen = room ? `/?room=${encodeURIComponent(room)}` : '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // Si l'app est déjà ouverte, on la focus
      for (let client of windowClients) {
        if (client.url.includes(location.origin) && 'focus' in client) {
          return client.focus().then(() => client.navigate(urlToOpen));
        }
      }
      // Sinon, on ouvre l'application
      if (clients.openWindow) return clients.openWindow(urlToOpen);
    })
  );
});