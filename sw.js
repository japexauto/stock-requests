// Service worker: only used for phone alerts. It doesn't cache anything, so updates show straight away.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Stock request', {
    body: d.body || '',
    icon: 'assets/icon-512.png',
    badge: 'assets/favicon.png',
    data: { url: d.url || './#open' },
    requireInteraction: Boolean(d.urgent)
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './#open', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if ('focus' in c) { if ('navigate' in c) c.navigate(url); return c.focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
