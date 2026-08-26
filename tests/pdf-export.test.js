/* PDF 직접 생성(html2canvas+jsPDF, vendor/ 고정버전) — 총괄 승인 3단계, 2026-08-26
 * 루트(운영) index.html만 대상. html2canvas/jsPDF 자체의 렌더링 정확도는 이 테스트의
 * 대상이 아니다(실기기 확인 항목) — printBtn/phsPrintBtn의 오케스트레이션 로직(중복 클릭
 * 방지, .no-print 제외, Blob→saveFileSafely 연결, 실패 시 자동 print() 미호출, 화면 상태
 * 복원, 오프라인 재시도)을 검증하기 위해 두 라이브러리를 가벼운 스텁으로 대체한다. */
const fs=require('fs'), path=require('path');
const {JSDOM}=require('jsdom');
const ROOT=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(ROOT,'index.html'),'utf-8');
/* phs-integration.test.js와 동일한 패턴: jsdom은 리소스 로더 없이 <script src>를 실행하지
   않으므로, PHS.analyze()를 쓰는 D 시나리오를 위해 phs-engine.js/phs-report.js를 인라인한다. */
const engineJs=fs.readFileSync(path.join(ROOT,'phs-engine.js'),'utf-8');
const reportJs=fs.readFileSync(path.join(ROOT,'phs-report.js'),'utf-8');
const drugModelJs=fs.readFileSync(path.join(ROOT,'simulation-drugmodel.js'),'utf-8');
const inlinedHtml=html
  .replace('<script src="phs-engine.js"></script>',`<script>${engineJs}</script>`)
  .replace('<script src="phs-report.js"></script>',`<script>${reportJs}</script>`)
  .replace('<script src="simulation-drugmodel.js"></script>',`<script>${drugModelJs}</script>`);

let pass=0, fail=0;
const ok=(c,n)=>{ c?pass++:fail++; console.log((c?"  ✔ ":"  ✘ FAIL: ")+n); };
const tick=(ms)=>new Promise(r=>setTimeout(r,ms||30));

function newWindow(){
  const errs=[];
  const dom=new JSDOM(inlinedHtml,{runScripts:"dangerously",url:"https://localhost/",pretendToBeVisual:true});
  const w=dom.window;
  w.addEventListener("error",e=>errs.push(e.message));
  w.URL.createObjectURL=(b)=>`blob:mock-${Math.random()}`;
  w.URL.revokeObjectURL=()=>{};
  w._errs=errs;
  return w;
}
function freshDb(w, seedEvents){
  const KEY=w.eval("KEY");
  const seed={ events:seedEvents||[], meds:[], questions:[], settings:{theme:"light",notify:false}, outputChecks:[], dayMemos:{} };
  w.localStorage.setItem(KEY, JSON.stringify(seed));
  w.eval("db=load(); renderAll();");
  return w;
}
function getToastText(w){ return w.document.getElementById("toast").textContent; }

/* html2canvas/jsPDF를 대체하는 가벼운 스텁. tallCanvas=true면 A4 한 장보다 큰 캔버스를
   반환해 페이지 분할 경로를 태운다. */
function stubPdfLibs(w, { tallCanvas=false, throwOnCanvas=false }={}){
  const calls={ html2canvas:[], addPage:0, addImage:[], ignoreElementsFn:null };
  w.html2canvas=async (el, opts)=>{
    calls.html2canvas.push(el);
    calls.ignoreElementsFn=opts.ignoreElements;
    if(throwOnCanvas) throw new Error("캡처 실패(테스트로 강제 발생)");
    const w1=800, h1=tallCanvas?4000:400; // usableW≈194mm→약 733px @2x 기준 400px는 한 페이지 이내, 4000은 여러 페이지 필요
    return {
      width:w1, height:h1,
      getContext:()=>({
        getImageData:()=>({ data:new Uint8ClampedArray(w1*4).fill(255) }) // 항상 '흰 여백'으로 응답 → 안전분할 즉시 성립
      }),
      toDataURL:()=>"data:image/jpeg;base64,ZmFrZQ=="
    };
  };
  function FakeCanvasEl(){ this.width=0; this.height=0; }
  FakeCanvasEl.prototype.getContext=function(){ return { drawImage(){}, getImageData:()=>({data:new Uint8ClampedArray(this.width*4).fill(255)}) }; };
  FakeCanvasEl.prototype.toDataURL=function(){ return "data:image/jpeg;base64,c2xpY2U="; };
  const origCreateElement=w.document.createElement.bind(w.document);
  w.document.createElement=(tag)=>{ if(tag==="canvas") return new FakeCanvasEl(); return origCreateElement(tag); };
  class FakeJsPDF{
    constructor(opts){ this.opts=opts; this._pages=1; }
    addPage(){ this._pages++; calls.addPage++; }
    addImage(dataUrl,type,x,y,wmm,hmm){ calls.addImage.push({dataUrl,type,x,y,wmm,hmm}); }
    output(type){ return new w.Blob(["FAKE_PDF_pages="+this._pages], {type:"application/pdf"}); }
  }
  w.jspdf={ jsPDF:FakeJsPDF };
  return calls;
}

(async ()=>{
  console.log("== A. 온라인 성공 — 일반 보고서(#tab-report), 중복 클릭 방지 ==");
  {
    const w=newWindow(); freshDb(w, [{id:"e1",type:"state",state:"on",ts:Date.now(),output:60,trend:"stable",symptoms:[],customSymptom:""}]);
    const calls=stubPdfLibs(w, {});
    let sharedFile=null;
    w.navigator.canShare=(d)=>!!(d&&d.files&&d.files.length===1);
    w.navigator.share=async (d)=>{ sharedFile=d.files[0]; };
    const btn=w.document.getElementById("printBtn");
    btn.click();
    ok(btn.disabled===true, "클릭 직후 즉시 버튼이 비활성화됨(다음 tick을 기다리지 않고 동기적으로)");
    ok(btn.textContent.includes("만드는 중"), "버튼 문구가 'PDF 만드는 중…'으로 바뀜: "+btn.textContent);
    btn.click(); // 생성 중 두 번째 클릭 — 무시돼야 함
    await tick(80);
    ok(calls.html2canvas.length===1, "생성 중 중복 클릭은 무시되어 html2canvas가 한 번만 호출됨(실제 "+calls.html2canvas.length+"회)");
    ok(!!sharedFile, "완료 후 saveFileSafely를 거쳐 공유가 시도됨");
    ok(sharedFile && sharedFile.type==="application/pdf", "공유된 파일의 MIME이 application/pdf: "+(sharedFile&&sharedFile.type));
    ok(sharedFile && /^출력_보고서_\d{4}-\d{2}-\d{2}\.pdf$/.test(sharedFile.name), "파일명 형식이 지시서 예시와 일치: "+(sharedFile&&sharedFile.name));
    ok(btn.disabled===false && !btn.textContent.includes("만드는 중"), "완료 후 버튼이 원상태로 복원됨");
    /* PR #2 검수 반영: navigator.share() 완료는 파일 저장을 보장하지 않으므로 "저장을
       완료했다"가 아니라 "공유를 완료했다"는 문구로 구분해야 한다. */
    ok(getToastText(w)==="PDF 파일 공유를 완료했어요", "공유 성공 시 '저장'이 아니라 '공유 완료' 문구 사용(저장을 단정하지 않음): "+getToastText(w));
  }

  console.log("== B. .no-print 요소는 캡처에서 제외(ignoreElements) ==");
  {
    const w=newWindow(); freshDb(w, []);
    const calls=stubPdfLibs(w, {});
    w.navigator.canShare=()=>false; // 다운로드 경로로
    w.document.getElementById("printBtn").click();
    await tick(80);
    ok(typeof calls.ignoreElementsFn==="function", "html2canvas에 ignoreElements 콜백이 전달됨");
    const noPrintEl=w.document.querySelector(".no-print");
    const normalEl=w.document.getElementById("reportBody");
    ok(!!noPrintEl && calls.ignoreElementsFn(noPrintEl)===true, "no-print 요소는 캡처 제외 대상으로 판정됨");
    ok(calls.ignoreElementsFn(normalEl)===false, "일반 콘텐츠 요소는 캡처 대상으로 유지됨");
  }

  console.log("== C. 대용량(여러 장) 보고서 — 안전 분할로 페이지 나뉨, 빈 루프 없음 ==");
  {
    const w=newWindow(); freshDb(w, []);
    const calls=stubPdfLibs(w, { tallCanvas:true });
    w.navigator.canShare=()=>false;
    const before=Date.now();
    w.document.getElementById("printBtn").click();
    await tick(150);
    ok(Date.now()-before<5000, "긴 콘텐츠도 무한루프 없이 합리적 시간 내 완료됨");
    ok(calls.addPage>=1, "한 페이지를 넘는 캔버스는 실제로 여러 페이지로 나뉨(addPage 호출 "+calls.addPage+"회)");
    ok(getToastText(w).includes("저장을 요청했어요"), "다운로드 폴백 문구 확인: "+getToastText(w));
  }

  console.log("== D. PHS 보고서 — .phs-page 여러 장을 그대로 각각 캡처 ==");
  {
    const w=newWindow();
    const seed=[]; const T=(dd,h,m)=>{ const d=new Date(); d.setDate(d.getDate()-dd); d.setHours(h,m,0,0); return d.getTime(); };
    for(let dd=4; dd>=0; dd--){
      seed.push({id:"o"+dd, type:"state", state:"on", ts:T(dd,9,0), output:60+dd, trend:"stable", symptoms:[], customSymptom:""});
      seed.push({id:"m"+dd, type:"med", drug:"퍼킨", dose:100, ts:T(dd,8,0)});
    }
    freshDb(w, seed);
    const calls=stubPdfLibs(w, {});
    w.navigator.canShare=()=>false;
    const report=w.eval(`(function(){
      const startTs=${Date.now()-6*86400000}, endTs=${Date.now()+86400000};
      const analysis=PHS.analyze({events:db.events, startTs, endTs});
      const confidence=PHS.assessConfidence(analysis, null);
      const report=PHS.buildReport({profile:null, startSurvey:null, endSurvey:null, analysis, confidence, medsList:db.meds, lang:"ko", challengeTests:[], therapeuticWindow:null, validation:null});
      window.__phsAnalysis=analysis;
      phsRenderReport(report, analysis, null);
      return true;
    })()`);
    ok(report===true, "phsRenderReport() 정상 호출됨(사전 준비)");
    const pageCount=w.document.querySelectorAll(".phs-page").length;
    ok(pageCount===3, "PHS 보고서가 기존과 동일하게 3개 phs-page로 구성됨(실제 "+pageCount+"개)");
    const btn=w.document.getElementById("phsPrintBtn");
    btn.click();
    await tick(150);
    ok(calls.html2canvas.length===pageCount, "phs-page 개수만큼 각각 캡처됨(html2canvas 호출 "+calls.html2canvas.length+"회)");
    ok(getToastText(w).includes("저장을 요청했어요") , "PHS도 동일한 saveFileSafely 경로를 탐: "+getToastText(w));
  }

  console.log("== E. 캡처 실패 시 window.print() 자동 호출 없음, 성공으로 표시하지 않음 ==");
  {
    const w=newWindow(); freshDb(w, []);
    stubPdfLibs(w, { throwOnCanvas:true });
    let printCalled=false;
    w.print=()=>{ printCalled=true; };
    const btn=w.document.getElementById("printBtn");
    btn.click();
    await tick(80);
    ok(!printCalled, "캡처가 실패해도 window.print()를 자동으로 호출하지 않음");
    ok(getToastText(w).includes("실패"), "실패를 성공처럼 표시하지 않고 명확한 실패 안내를 띄움: "+getToastText(w));
    ok(btn.disabled===false, "실패 후에도 버튼이 다시 활성화됨(영구 비활성 방지)");
    ok(w._errs.length===0, "실패가 처리되지 않은 예외로 새지 않음(콘솔 오류로만 남고 앱은 정상): "+w._errs.join("; "));
  }

  console.log("== F. 오프라인(라이브러리 로드 실패) — 실패로 처리되고, 복구 후 재시도 가능 ==");
  {
    const w=newWindow(); freshDb(w, []);
    // 이번엔 jspdf/html2canvas를 미리 심어두지 않아 loadPdfLibs()가 실제로 <script>를 주입하게 한다
    let printCalled=false; w.print=()=>{ printCalled=true; };
    const btn=w.document.getElementById("printBtn");
    btn.click();
    const scriptEl=w.document.querySelector('script[src*="html2canvas"]');
    ok(!!scriptEl, "오프라인 재현을 위해 vendor 스크립트 태그가 실제로 삽입됨(CDN 아님): "+(scriptEl&&scriptEl.src));
    ok(scriptEl && scriptEl.src.indexOf("cdn")===-1, "스크립트 출처에 CDN 도메인이 없음(로컬 vendor 경로만 사용)");
    if(scriptEl && scriptEl.onerror) scriptEl.onerror(new Error("network offline"));
    await tick(80);
    ok(!printCalled, "라이브러리 로드 실패 시에도 window.print()로 자동 대체하지 않음");
    ok(getToastText(w).includes("실패"), "오프라인 실패 안내 표시: "+getToastText(w));
    ok(btn.disabled===false, "실패 후 버튼 재활성화");

    console.log("-- 복구 후 재시도: 캐시된 실패 프라미스에 영구히 갇히지 않는지 --");
    stubPdfLibs(w, {}); // 이제 '온라인'이 됐다고 가정하고 라이브러리를 즉시 사용 가능하게 스텁
    w.navigator.canShare=()=>false;
    btn.click();
    await tick(80);
    ok(getToastText(w).includes("저장을 요청했어요"), "이전 실패 이후에도 재시도가 정상적으로 성공함(재시도 가능 확인): "+getToastText(w));
  }

  console.log("== G. 부분 실패 후 재시도 — 이미 로드된 라이브러리는 다시 삽입하지 않음 ==");
  {
    /* PR #2 검수 반영: html2canvas는 로드에 성공했는데 jsPDF만 실패한 뒤 재시도하면,
       loadPdfLibs()가 html2canvas <script>를 다시 삽입해서는 안 된다 — 각 라이브러리는
       전역 객체 존재 여부로 개별 판단해야 한다. */
    const w=newWindow(); freshDb(w, []);
    const btn=w.document.getElementById("printBtn");
    btn.click();
    const h2cScript=w.document.querySelector('script[src*="html2canvas"]');
    ok(!!h2cScript, "1차 시도: html2canvas 스크립트 태그 삽입됨");
    /* 실제로는 vendor 스크립트가 로드되며 전역에 등록되는 것을 흉내(캡처까지 실제로
       완주시켜야 하므로 stubPdfLibs()와 동일한 모양의 최소 fake canvas를 반환) */
    w.html2canvas=async(el,opts)=>({
      width:800, height:400,
      getContext:()=>({ getImageData:()=>({ data:new Uint8ClampedArray(3200).fill(255) }) }),
      toDataURL:()=>"data:image/jpeg;base64,ZmFrZQ=="
    });
    h2cScript.onload();
    await tick(20);
    const jspdfScript1=w.document.querySelector('script[src*="jspdf"]');
    ok(!!jspdfScript1, "1차 시도: html2canvas 성공 후 이어서 jsPDF 스크립트 태그도 삽입됨");
    jspdfScript1.onerror(new Error("jsPDF load failed"));
    await tick(80);
    ok(getToastText(w).includes("실패"), "jsPDF만 실패해도 전체가 실패로 처리됨: "+getToastText(w));

    console.log("-- 재시도: html2canvas는 이미 로드됨(window.html2canvas 존재) → 다시 삽입되지 않아야 함 --");
    btn.click();
    await tick(20);
    const h2cScriptsAfterRetry=w.document.querySelectorAll('script[src*="html2canvas"]');
    const jspdfScriptsAfterRetry=w.document.querySelectorAll('script[src*="jspdf"]');
    ok(h2cScriptsAfterRetry.length===1, "재시도 후에도 html2canvas 스크립트 태그는 여전히 1개뿐(중복 삽입 없음, 실제 "+h2cScriptsAfterRetry.length+"개)");
    ok(jspdfScriptsAfterRetry.length===2, "실패했던 jsPDF만 새로 다시 삽입됨(누적 2개 — 1차 실패분 + 재시도분)");
    const jspdfScript2=jspdfScriptsAfterRetry[jspdfScriptsAfterRetry.length-1];
    class FakeJsPDF2{ constructor(o){this.o=o; this._p=1;} addPage(){this._p++;} addImage(){} output(t){ return new w.Blob(["FAKE"],{type:"application/pdf"}); } }
    w.jspdf={jsPDF:FakeJsPDF2};
    w.navigator.canShare=()=>false;
    jspdfScript2.onload();
    await tick(80);
    ok(getToastText(w).includes("저장을 요청했어요"), "html2canvas 재사용 + jsPDF만 재로드로 재시도가 정상적으로 성공함: "+getToastText(w));
  }

  console.log("== H. 생성 전후 화면 스크롤 위치 복원 ==");
  {
    const w=newWindow(); freshDb(w, []);
    stubPdfLibs(w, {});
    w.navigator.canShare=()=>false;
    let scrollCalledWith=null;
    Object.defineProperty(w, "scrollY", { value:321, configurable:true });
    w.scrollTo=(x,y)=>{ scrollCalledWith=[x,y]; };
    w.document.getElementById("printBtn").click();
    await tick(80);
    ok(!!scrollCalledWith, "생성 완료 후 스크롤 위치를 복원하려 시도함");
    ok(scrollCalledWith && scrollCalledWith[1]===321, "복원 위치가 생성 시작 시점의 스크롤 위치와 동일함: "+JSON.stringify(scrollCalledWith));
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error("TEST HARNESS ERROR:", e); process.exit(1); });
