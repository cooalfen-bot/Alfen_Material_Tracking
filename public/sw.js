// Network first, so a new deployment is picked up straight away. The cache is only a fallback when offline.
const C = 'alfen-v1';
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(C).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icon-192.png'])));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => { const copy = r.clone(); caches.open(C).then((c) => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request).then((m) => m || caches.match('/')))
  );
});
