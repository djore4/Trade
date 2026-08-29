// Service worker do CryptoScan — recebe Web Push e mostra as notificações de
// volatilidade, mesmo com a app fechada. Sem cache/offline (mantém-se simples).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (_e) { data = { title: 'CryptoScan', body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'CryptoScan';
  const options = {
    body: data.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: 'cs-vol',            // agrupa (substitui a anterior em vez de empilhar)
    renotify: true,
    data: data.data || {},
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) { if ('focus' in w) return w.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    }),
  );
});
