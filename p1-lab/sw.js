const CACHE='p1-lab-shell-v3-essay';
const SHELL=['./','./index.html','./manifest.webmanifest','./icon.svg','./medication-output-overlay.svg'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('p1-lab-shell-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url),base=new URL(self.registration.scope);
 if(event.request.method!=='GET'||url.origin!==base.origin||!url.pathname.startsWith(base.pathname))return;
 const rel=url.pathname.slice(base.pathname.length);
 if(!['','index.html','manifest.webmanifest','icon.svg','medication-output-overlay.svg'].includes(rel))return;
 event.respondWith(fetch(event.request).then(response=>{
  if(response.ok){const copy=response.clone();event.waitUntil(caches.open(CACHE).then(c=>c.put(event.request,copy)));}
  return response;
 }).catch(async()=>{const hit=await caches.match(event.request);return hit||(event.request.mode==='navigate'?await caches.match(new URL('./index.html',self.registration.scope).href):null)||Response.error();}));
});
