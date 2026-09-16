const CACHE = 'p1-lab-shell-v1.1.1-20260916';
const FILES = ['index.html','manifest.webmanifest','icon.svg','medication-output-overlay.svg','engine.js','core.js','medication.js','app.js','dedup-ui.js','pwa.js'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES.map(f => './' + f))).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('p1-lab-shell-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url), base = new URL(self.registration.scope);
  if (event.request.method !== 'GET' || url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return;
  const relative = url.pathname.slice(base.pathname.length) || 'index.html';
  if (!FILES.includes(relative)) return;
  // Canonical per-version keys permit offline reloads with ?v=1.1.1 URLs.
  const key = new URL(relative, base).href;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then(cache => cache.put(key, copy)));
    }
    return response;
  }).catch(async () => (await (await caches.open(CACHE)).match(key)) || Response.error()));
});
