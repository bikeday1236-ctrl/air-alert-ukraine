const C = 'aau-v1', SHELL = ['/', '/app.js', '/style.css', '/manifest.json', '/icon.svg', '/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css'];
self.addEventListener('install', e => e.waitUntil(caches.open(C).then(c => c.addAll(SHELL))));
self.addEventListener('activate', e => e.waitUntil(clients.claim()));
self.addEventListener('fetch', e => {
  if (new URL(e.request.url).pathname.startsWith('/api/')) return; // дані завжди з мережі
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
