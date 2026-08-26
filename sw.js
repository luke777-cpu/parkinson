const CACHE = "yakhyo-v2162-pdflibs";
const APP_SHELL = [
  "./",
  "./index.html",
  "./shared-profile.js",
  "./simulation-drugmodel.js",
  "./analysis-clinical.js",
  "./analysis-threshold.js",
  "./analysis-coverage.js",
  "./analysis-candidates.js",
  "./analysis-validation.js",
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
/* v2.16.2: PDF 직접 생성(html2canvas+jsPDF)에 쓰는 vendor 라이브러리. 보고서·PHS 탭을
   쓰지 않는 사용자에게도 필요한 핵심 앱 셸은 아니므로, addAll(하나라도 실패하면 설치 전체
   실패)에 넣지 않고 별도로 시도한다 — 이 두 파일 캐싱이 실패해도(네트워크 문제 등) 앱
   설치 자체는 정상적으로 끝나야 한다. 여기서 못 받아도 최초 PDF 생성 시 index.html의
   loadPdfLibs()가 다시 네트워크로 시도한다. */
const PDF_LIBS = [
  "./vendor/html2canvas.min.js",
  "./vendor/jspdf.umd.min.js"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(APP_SHELL)
        .then(() => Promise.all(PDF_LIBS.map(url =>
          cache.add(url).catch(err => console.warn("PDF 라이브러리 사전 캐싱 실패(설치는 계속 진행):", url, err))
        )))
        .then(() => cache)
      )
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
