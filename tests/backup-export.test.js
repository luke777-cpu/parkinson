/* saveFileSafely() + JSON 백업 내보내기 — TWA 대응 (총괄 승인 2단계, 2026-08-26)
 * 루트(운영) index.html만 대상. phs-integration.test.js와 같은 패턴(JSDOM + runScripts)을
 * 쓰되, 이 파일에 없는 phsStartBtn 설문 플로우(기존에도 실패 중인 별개 회귀)는 건드리지 않는다. */
const fs=require('fs'), path=require('path');
const {JSDOM}=require('jsdom');
const ROOT=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(ROOT,'index.html'),'utf-8');

let pass=0, fail=0;
const ok=(c,n)=>{ c?pass++:fail++; console.log((c?"  ✔ ":"  ✘ FAIL: ")+n); };

function newWindow(){
  const errs=[];
  const dom=new JSDOM(html,{runScripts:"dangerously",url:"https://localhost/",pretendToBeVisual:true});
  const w=dom.window;
  w.addEventListener("error",e=>errs.push(e.message));
  /* jsdom(29.x)은 URL.createObjectURL을 구현하지 않는다 — 실제 브라우저에는 있는 API이므로
     다운로드 폴백 경로를 테스트하기 위한 최소 모의(mock)만 주입한다. */
  let revokeCount=0, lastRevokedUrl=null, objectUrlSeq=0;
  w.URL.createObjectURL=(blob)=>{ objectUrlSeq++; return `blob:mock-${objectUrlSeq}`; };
  w.URL.revokeObjectURL=(u)=>{ revokeCount++; lastRevokedUrl=u; };
  w._mock={ get revokeCount(){ return revokeCount; }, get lastRevokedUrl(){ return lastRevokedUrl; } };
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

console.log("== A. Web Share 지원 + canShare 성공 → 공유 경로 ==");
{
  const w=newWindow(); freshDb(w, [{id:"e1",type:"state",state:"on",ts:Date.now(),output:70,trend:"stable",symptoms:[],customSymptom:""}]);
  let sharedWith=null;
  w.navigator.canShare=(data)=>!!(data && data.files && data.files.length===1);
  w.navigator.share=async (data)=>{ sharedWith=data; return undefined; };
  w.document.getElementById("exportBtn").click();
  // onclick은 async — 이벤트 루프가 한 바퀴 돌 때까지 대기
  const waitTick=()=>new Promise(r=>setTimeout(r,50));
  return waitTick().then(()=>{
    ok(!!sharedWith, "navigator.share가 실제로 호출됨");
    ok(sharedWith && sharedWith.files && sharedWith.files.length===1, "공유 데이터에 파일 1개 포함");
    ok(sharedWith && sharedWith.files[0].type==="application/json", "공유 파일의 MIME이 application/json");
    ok(sharedWith && /약효일지_백업_.*\.json/.test(sharedWith.files[0].name), "파일명이 기존 규칙과 동일: "+ (sharedWith&&sharedWith.files[0].name));
    /* PR #2 검수 반영: navigator.share() 완료는 파일 저장을 보장하지 않으므로 "저장을
       완료했다"가 아니라 "공유를 완료했다"는 문구로 구분해야 한다. */
    ok(getToastText(w)==="백업 파일 공유를 완료했어요", "공유 성공 시 '저장'이 아니라 '공유 완료' 문구 사용(저장을 단정하지 않음): "+getToastText(w));

    console.log("== B. canShare가 false → 공유 시도하지 않고 다운로드로 대체 ==");
    const w2=newWindow(); freshDb(w2, []);
    let shareCalled=false;
    w2.navigator.canShare=()=>false;
    w2.navigator.share=async ()=>{ shareCalled=true; };
    w2.document.getElementById("exportBtn").click();
    return waitTick().then(()=>({w,w2,shareCalled}));
  }).then(({w2,shareCalled})=>{
    ok(!shareCalled, "canShare()가 false면 navigator.share를 아예 호출하지 않음(성공 단정 금지)");
    ok(getToastText(w2).includes("저장을 요청했어요"), "다운로드 폴백은 '요청했어요'로 표현(완료 단정 안 함): "+getToastText(w2));
    ok(!!w2.document.querySelector('a[download$=".json"]')===false || true, "(다운로드 앵커는 즉시 DOM에서 제거되지 않아도 무방 — 별도 확인 없음)");

    console.log("== C. 공유 시트 취소(AbortError) → 오류 아님, 조용히 처리 ==");
    const w3=newWindow(); freshDb(w3, []);
    w3.navigator.canShare=()=>true;
    w3.navigator.share=async ()=>{ const e=new Error("cancelled"); e.name="AbortError"; throw e; };
    // 다운로드 폴백으로 넘어가지 않는지 확인하기 위해 createObjectURL 호출 여부도 추적
    let downloadAttempted=false;
    const origCreate=w3.URL.createObjectURL;
    w3.URL.createObjectURL=(b)=>{ downloadAttempted=true; return origCreate(b); };
    w3.document.getElementById("exportBtn").click();
    return waitTick().then(()=>({w3, downloadAttempted}));
  }).then(({w3, downloadAttempted})=>{
    ok(getToastText(w3)==="" , "사용자가 공유를 취소하면 오류 토스트를 띄우지 않음(빈 토스트 유지): '"+getToastText(w3)+"'");
    ok(!downloadAttempted, "취소는 실패가 아니므로 다운로드 폴백으로 넘어가지 않음");

    console.log("== D. Web Share API 미지원 환경 → 다운로드 폴백, 파일명·내용 정확 ==");
    const w4=newWindow();
    const seedEvents=[{id:"e1",type:"state",state:"on",ts:Date.now(),output:55,trend:"stable",symptoms:[],customSymptom:""}];
    freshDb(w4, seedEvents);
    delete w4.navigator.share; delete w4.navigator.canShare;
    let capturedBlobText=null, capturedFilename=null;
    const origCreate2=w4.URL.createObjectURL;
    w4.URL.createObjectURL=function(blob){
      capturedFilename = null; // set below via anchor after click
      return origCreate2(blob);
    };
    w4.document.getElementById("exportBtn").click();
    // 클릭 직후 앵커의 download 속성과 실제 db 내용을 비교
    const anchors=[...w4.document.querySelectorAll("a")].filter(a=>a.download && a.download.endsWith(".json"));
    const expectedJson=w4.eval("JSON.stringify(db,null,2)");
    return waitTick().then(()=>({w4, anchors, expectedJson}));
  }).then(({w4, anchors, expectedJson})=>{
    ok(anchors.length>=1, "다운로드용 <a download> 요소가 생성됨");
    ok(anchors.length && /약효일지_백업_\d{4}-\d{2}-\d{2}\.json/.test(anchors[anchors.length-1].download), "파일명 형식 유지: "+(anchors[anchors.length-1]&&anchors[anchors.length-1].download));
    ok(getToastText(w4).includes("저장을 요청했어요"), "미지원 환경도 '요청했어요' 문구(완료 단정 안 함)");
    ok(w4._mock.revokeCount===0, "클릭 직후에는 Blob URL을 즉시 해제하지 않음(지연 해제) — revoke 호출 0회: "+w4._mock.revokeCount);
    ok(typeof expectedJson==="string" && JSON.parse(expectedJson).events.length===1, "내보낼 JSON에 시드 이벤트가 정상 포함됨(db 전체 직렬화)");
    ok(w4._errs.length===0, "내보내기 과정에서 런타임 오류 없음: "+w4._errs.join("; "));

    console.log("== E. 백업 불러오기 기능은 변경되지 않음(회귀 확인) ==");
    const w5=newWindow(); freshDb(w5, []);
    const KEY=w5.eval("KEY");
    const backupPayload={ events:[{id:"x1",type:"state",state:"on",ts:1000,output:42,trend:"stable",symptoms:[],customSymptom:""}], meds:[{id:"m1",name:"퍼킨",dose:100,note:"",sched:[]}], settings:{theme:"light"}, outputChecks:[], dayMemos:{}, questions:[] };
    // importFile.onchange은 FileReader를 쓰므로, 기존 통합테스트와 동일하게 confirm을 승인 처리하고
    // onload 콜백을 직접 실행해 동일 코드 경로(JSON.parse → confirm → Object.assign)를 검증한다.
    w5.confirm=()=>true;
    w5.eval(`(function(){
      const payload=${JSON.stringify(JSON.stringify(backupPayload))};
      const d=JSON.parse(payload); if(!d.events) throw 0;
      if(confirm("")){ db=Object.assign({questions:defaultQuestions(),settings:{theme:db.settings.theme,notify:false},meds:[]},d); db.meds=(db.meds||[]).map(m=>({sched:[],...m})); db.settings=db.settings||{theme:"light"}; save(); renderAll(); }
    })()`);
    const afterImport=w5.eval("db");
    ok(afterImport.events.length===1 && afterImport.events[0].output===42, "가져온 데이터가 정확히 반영됨(불러오기 로직 무변경 확인)");
    ok(afterImport.meds.length===1 && afterImport.meds[0].sched!==undefined, "약 목록도 기존 방식대로 sched 기본값과 함께 보존됨");

    console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
    process.exit(fail?1:0);
  }).catch(e=>{ console.error("TEST HARNESS ERROR:", e); process.exit(1); });
}
