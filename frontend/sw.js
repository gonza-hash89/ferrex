/* FERREX SW — app-shell cache + runtime uploads con fallback */
const VERSION = 'frx-v1.3';
const CORE = ['/', '/index.html', '/app.js', '/manifest.json'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Imágenes subidas: cache-first con fallback offline
  if (url.pathname.startsWith('/uploads/')) {
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
        const copy = r.clone();
        caches.open(VERSION).then(c => c.put(e.request, copy));
        return r;
      }).catch(() => caches.match('/icons/icon.svg')))
    );
    return;
  }
  // Navegación: network-first con fallback a shell
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/index.html')));
    return;
  }
});
