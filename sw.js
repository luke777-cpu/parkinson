const CACHE = "yakhyo-v42-survey130";
const APP_SHELL = [
  "./",
  "./index.html",
  "./shared-profile.js",
  "./simulation-drugmodel.js",
  "./drug-dictionary.json",
  "./phs-engine.js",
  "./phs-report.js",
  "./manifest.json",
  "./privacy.html",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-192-maskable.png",
  "./icon-512-maskable.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  { /* v0.9.21: 챌린지·이스터에그는 각자 SW/네트워크가 처리 — 본체 캐시가 가로채지 않음 */
    const p=new URL(event.request.url).pathname;
    if (p.includes("/challenge/") || p.includes("/easteregg/")) return;
  }

  // HTML navigation is network-first so GitHub Pages updates do not remain stuck on an old version.
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then(cache => cache.put("./index.html", copy));
          }
          return response;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  // Static assets are served quickly, then refreshed in the background.
  event.respondWith(
    caches.match(event.request).then(cached => {
      const network = fetch(event.request).then(response => {
        if (response && response.ok && (response.type === "basic" || response.type === "cors")) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, copy));
        }
        return response;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
