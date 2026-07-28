/* 약효 비교 테스트 전용 서비스워커 — 본체(yakhyo-*)와 캐시 완전 분리 */
const CACHE_NAME = "medication-challenge-v1";
const ASSETS = ["./","./index.html","./challenge.css","./challenge-engine.js","./challenge-report.js","./manifest.json"];
self.addEventListener("install", e=>{ e.waitUntil(caches.open(CACHE_NAME).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())); });
self.addEventListener("activate", e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(
    ks.filter(k=>k.startsWith("medication-challenge-")&&k!==CACHE_NAME).map(k=>caches.delete(k))
  )).then(()=>self.clients.claim()));
});
self.addEventListener("fetch", e=>{
  if(e.request.method!=="GET") return;
  e.respondWith(fetch(e.request).then(r=>{ const cp=r.clone(); caches.open(CACHE_NAME).then(c=>c.put(e.request,cp)); return r; })
    .catch(()=>caches.match(e.request)));
});
