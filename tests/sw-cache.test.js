/* 서비스워커(sw.js) 캐시 목록·오프라인 로딩 — 4단계(서비스워커/오프라인 준비, 총괄 승인
 * 2026-08-26). 실제 브라우저 없이, Node vm 컨텍스트에 self/caches/fetch를 최소 모의로
 * 주입해 sw.js 원본을 그대로 실행하고 install/activate/fetch 이벤트 핸들러를 직접 구동한다.
 * cache.add()/addAll()은 로컬에 띄운 정적 파일 서버에 실제 fetch로 요청해, 실제 저장소
 * 파일(vendor/*.js 포함)을 그대로 캐싱한다 — 파일 존재 여부·내용까지 함께 검증된다. */
const fs=require('fs'), path=require('path');
const vm=require('vm');
const http=require('http');
const ROOT=path.join(__dirname,'..');
const swSrc=fs.readFileSync(path.join(ROOT,'sw.js'),'utf-8');
const idxHtml=fs.readFileSync(path.join(ROOT,'index.html'),'utf-8');

let pass=0, fail=0;
const ok=(c,n)=>{ c?pass++:fail++; console.log((c?"  ✔ ":"  ✘ FAIL: ")+n); };

const cacheNameMatch=swSrc.match(/const CACHE\s*=\s*"([^"]+)"/);
const CACHE_NAME=cacheNameMatch && cacheNameMatch[1];
const OLD_CACHE_NAME="yakhyo-v2161-steadybg"; /* 3단계 승인 시점까지의 기존 캐시 이름(회귀 기준) */

/* ---- 최소 인메모리 Cache API 모의 (cache.add/addAll은 아래 fakeFetch로 실제 파일을 받는다) ---- */
let BASE;
function normalize(url){ try{ return new URL(url, BASE).pathname; }catch(e){ return url; } }
class FakeCache{
  constructor(){ this.store=new Map(); }
  _key(x){ return typeof x==="string" ? x : x.url; }
  async add(x){
    const url=this._key(x);
    const res=await fakeFetch(url);
    if(!res || !res.ok) throw new Error("cache.add 실패(응답 실패 또는 오프라인): "+url);
    this.store.set(normalize(url), res);
  }
  async addAll(items){ for(const it of items) await this.add(it); }
  async put(x, res){ this.store.set(normalize(this._key(x)), res); }
  async match(x){ return this.store.get(normalize(this._key(x))); }
  async keys(){ return [...this.store.keys()]; }
}
class FakeCacheStorage{
  constructor(){ this.map=new Map(); }
  async open(name){ if(!this.map.has(name)) this.map.set(name, new FakeCache()); return this.map.get(name); }
  async keys(){ return [...this.map.keys()]; }
  async delete(name){ return this.map.delete(name); }
  async match(x){ for(const c of this.map.values()){ const r=await c.match(x); if(r) return r; } return undefined; }
}

/* ---- 온라인/오프라인 전환 가능한 fetch 모의 (실제로는 로컬 정적 서버를 호출) ---- */
let ONLINE=true, FAIL_PATHS=new Set();
async function fakeFetch(url){
  const u=new URL(url, BASE);
  if(!ONLINE) throw new Error("network offline (시뮬레이션)");
  if(FAIL_PATHS.has(u.pathname)) throw new Error("simulated fetch failure: "+u.pathname);
  return fetch(u.toString());
}

let server;
function startServer(){
  return new Promise(resolve=>{
    server=http.createServer((req,res)=>{
      let p=decodeURIComponent(req.url.split("?")[0]);
      if(p==="/"||p==="") p="/index.html";
      const fp=path.join(ROOT, p);
      fs.readFile(fp, (err,data)=>{
        if(err){ res.writeHead(404); res.end(); return; }
        res.writeHead(200); res.end(data);
      });
    });
    server.listen(0, "127.0.0.1", ()=>{ BASE=`http://127.0.0.1:${server.address().port}/`; resolve(); });
  });
}

function makeSandbox(){
  const handlers={};
  const selfObj={
    addEventListener(type, fn){ handlers[type]=fn; },
    skipWaiting(){ selfObj._skipWaitingCalled=true; },
    clients:{ claim(){ selfObj._claimCalled=true; } }
  };
  const sandbox={
    self:selfObj,
    caches:new FakeCacheStorage(),
    fetch:(input)=> fakeFetch(typeof input==="string"? input : input.url),
    console, URL, Promise
  };
  vm.createContext(sandbox);
  new vm.Script(swSrc, {filename:"sw.js"}).runInContext(sandbox);
  return {sandbox, handlers, self:selfObj};
}
async function runInstall(handlers){
  let p=Promise.resolve();
  handlers.install({ waitUntil(x){ p=x; } });
  return p;
}
async function runActivate(handlers){
  let p=Promise.resolve();
  handlers.activate({ waitUntil(x){ p=x; } });
  return p;
}
function runFetch(handlers, req){
  let responded=null;
  handlers.fetch({ request:req, respondWith(p){ responded=p; } });
  return responded;
}

(async ()=>{
  await startServer();

  console.log("== A. 캐시 이름이 이번 수정에 맞춰 한 번만 갱신됨 ==");
  ok(!!CACHE_NAME, "sw.js에서 CACHE 상수를 정상적으로 읽음: "+CACHE_NAME);
  ok(CACHE_NAME!==OLD_CACHE_NAME, "3단계(PDF 복구) 이전 캐시 이름과 다르게 갱신됨: "+OLD_CACHE_NAME+" → "+CACHE_NAME);

  console.log("== B. 정상 설치 — APP_SHELL과 PDF 라이브러리 둘 다 캐싱됨 ==");
  {
    ONLINE=true; FAIL_PATHS=new Set();
    const {sandbox, handlers, self}=makeSandbox();
    await runInstall(handlers);
    const keys=await sandbox.caches.keys();
    ok(keys.length===1 && keys[0]===CACHE_NAME, "설치 후 캐시가 정확히 하나(현재 버전)만 생성됨: "+JSON.stringify(keys));
    const cache=await sandbox.caches.open(CACHE_NAME);
    const cachedKeys=await cache.keys();
    ok(cachedKeys.includes("/index.html"), "핵심 앱 셸(index.html) 캐싱됨");
    ok(cachedKeys.includes("/phs-engine.js") && cachedKeys.includes("/phs-report.js"), "PHS 엔진 파일들 캐싱됨(기존 유지)");
    ok(cachedKeys.includes("/vendor/html2canvas.min.js"), "vendor/html2canvas.min.js가 APP_SHELL에 추가되어 캐싱됨");
    ok(cachedKeys.includes("/vendor/jspdf.umd.min.js"), "vendor/jspdf.umd.min.js가 APP_SHELL에 추가되어 캐싱됨");
    ok(self._skipWaitingCalled===true, "정상 설치 후 skipWaiting() 호출됨");
    const cachedH2C=await cache.match("/vendor/html2canvas.min.js");
    const text=await cachedH2C.text();
    ok(text.includes("html2canvas"), "캐싱된 파일이 실제 html2canvas 소스임(더미 아님)");
  }

  console.log("== C. PDF 라이브러리 하나가 설치 중 캐싱 실패해도 앱 전체 설치는 성공함 ==");
  {
    ONLINE=true; FAIL_PATHS=new Set(["/vendor/html2canvas.min.js"]);
    const {sandbox, handlers, self}=makeSandbox();
    let threw=false;
    try{ await runInstall(handlers); }catch(e){ threw=true; }
    ok(!threw, "html2canvas 캐싱 실패에도 install의 waitUntil 프라미스가 reject되지 않음(설치 계속 진행)");
    ok(self._skipWaitingCalled===true, "일부 PDF 라이브러리 실패에도 설치가 끝까지 진행되어 skipWaiting() 호출됨");
    const cache=await sandbox.caches.open(CACHE_NAME);
    const cachedKeys=await cache.keys();
    ok(!cachedKeys.includes("/vendor/html2canvas.min.js"), "실패한 파일 자체는 캐시에 없음(정직하게 실패 처리)");
    ok(cachedKeys.includes("/vendor/jspdf.umd.min.js"), "실패하지 않은 나머지 PDF 라이브러리는 정상 캐싱됨");
    ok(cachedKeys.includes("/index.html") && cachedKeys.includes("/manifest.json"), "핵심 앱 셸은 PDF 라이브러리 실패와 무관하게 전부 정상 캐싱됨(앱 자체는 설치 불능 상태 아님)");
  }

  console.log("== D. (회귀 확인) 핵심 앱 셸 파일이 실패하면 기존과 동일하게 설치 자체가 실패함 ==");
  {
    ONLINE=true; FAIL_PATHS=new Set(["/index.html"]);
    const {handlers}=makeSandbox();
    let threw=false;
    try{ await runInstall(handlers); }catch(e){ threw=true; }
    ok(threw, "핵심 셸 파일 실패는 여전히 설치 실패로 이어짐(PDF 라이브러리만 예외 처리했음을 확인 — addAll의 기존 원자성 유지)");
  }

  console.log("== E. activate — 예전 캐시 이름 정리, 현재 캐시는 유지 ==");
  {
    ONLINE=true; FAIL_PATHS=new Set();
    const {sandbox, handlers, self}=makeSandbox();
    await sandbox.caches.open(OLD_CACHE_NAME); // 이전 버전이 남긴 캐시를 미리 심어둠
    await runInstall(handlers);
    let keys=await sandbox.caches.keys();
    ok(keys.includes(OLD_CACHE_NAME) && keys.includes(CACHE_NAME), "activate 전에는 옛 캐시와 새 캐시가 공존함(사전조건)");
    await runActivate(handlers);
    keys=await sandbox.caches.keys();
    ok(keys.length===1 && keys[0]===CACHE_NAME, "activate 후 옛 캐시는 삭제되고 현재 캐시만 남음: "+JSON.stringify(keys));
    ok(self._claimCalled===true, "activate 후 clients.claim() 호출됨");
  }

  console.log("== F. localStorage/앱 데이터는 캐시 정리 과정과 구조적으로 무관함 ==");
  ok(!/localStorage/.test(swSrc), "sw.js 소스 어디에도 localStorage를 참조하지 않음 — Cache API(파일 캐시)와 localStorage(앱 데이터)는 서로 다른 저장소이므로 activate의 캐시 정리가 db/설정에 영향을 줄 경로가 없음");

  console.log("== G. 온라인 1회 설치 → 오프라인 전환 후에도 보고서/PHS용 PDF 라이브러리가 로드됨 ==");
  {
    ONLINE=true; FAIL_PATHS=new Set();
    const {sandbox, handlers}=makeSandbox();
    await runInstall(handlers); // "온라인에서 한 번 실행"
    ONLINE=false; // "오프라인으로 전환"
    for(const p of ["vendor/html2canvas.min.js","vendor/jspdf.umd.min.js"]){
      const req={ method:"GET", mode:"cors", url:BASE+p };
      const respPromise=runFetch(handlers, req);
      const resp=await respPromise;
      ok(!!resp, "오프라인에서도 "+p+" 요청에 대한 응답을 반환함(네트워크 예외로 끊기지 않음)");
      const text=await resp.text();
      ok(text.length>1000, p+" 응답 내용이 실제 캐싱된 파일 그대로임(길이 "+text.length+")");
    }
    // 일반 보고서 탭이 여는 index.html 자체도 오프라인에서 캐시로 열림(네트워크 우선 → 실패 시 캐시)
    const navReq={ method:"GET", mode:"navigate", url:BASE+"index.html" };
    const navResp=await runFetch(handlers, navReq);
    ok(!!navResp, "오프라인에서 index.html 내비게이션도 캐시로 대체되어 응답을 받음");
  }

  console.log("== H. index.html의 로딩 경로와 sw.js의 캐싱 경로가 문자열 그대로 일치함(캐시 히트 보장) ==");
  ok(idxHtml.includes('"./vendor/html2canvas.min.js"'), "index.html이 정확히 ./vendor/html2canvas.min.js 경로로 로드함");
  ok(idxHtml.includes('"./vendor/jspdf.umd.min.js"'), "index.html이 정확히 ./vendor/jspdf.umd.min.js 경로로 로드함");
  ok(swSrc.includes('"./vendor/html2canvas.min.js"') && swSrc.includes('"./vendor/jspdf.umd.min.js"'), "sw.js도 동일한 경로 문자열로 등록되어 있어 캐시 키가 어긋나지 않음");

  server.close();
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error("TEST HARNESS ERROR:", e); if(server) server.close(); process.exit(1); });
