/* PHS 통합 테스트 — index.html 전체 로드 + 설문/생성/렌더/기존 기능 회귀
 * (5단계 승인, 2026-08-26: v1.2.0 개편 이후의 실제 버튼·흐름에 맞춰 갱신)
 *
 * v1.2.0 배포(커밋 3be92fa, 2026-08-04)에서 PHS 시작 화면이 "관찰 시작(phsStartBtn)/관찰
 * 종료(phsEndBtn)"라는 미래형 2단계 설문에서 "1.기본정보(phsProfileBtn) → 2.기간선택
 * (phsRangeBtn, 이미 쌓인 기록의 날짜 구간을 고르는 방식) → 3.설문/선택(phsSurveyBtn, 예전의
 * 시작·종료 설문을 한 화면으로 합침) → 생성(phsGenBtn)"이라는 4버튼 흐름으로 바뀌었다. 이
 * 테스트는 그 개편 이전 버튼(phsStartBtn/phsEndBtn/ps_save/pe_save/ps_date, db.phs.observations)을
 * 그대로 참조하고 있어 4단계 조사에서 "낡은 테스트"로 분류됐다(기능 자체는 정상 — phsGenBtn을
 * 직접 눌러 정상 생성됨을 별도 확인). 여기서는 없어진 버튼을 억지로 되살리지 않고, 지금 사용자가
 * 실제로 누르는 버튼·이벤트 흐름만 그대로 따라간다. 없어진 개념 하나: 예전엔 "가장 큰 어려움"을
 * 고르지 않으면 관찰 시작 자체가 막혔지만, 지금은 설문 전체가 선택 사항이라 그런 필수값 검증이
 * 없다 — 이 테스트도 그 필수값 검증은 더 이상 존재하지 않는 동작으로 취급하고 검사하지 않는다. */
const fs=require('fs'), path=require('path');
const {JSDOM}=require('jsdom');
const ROOT=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(ROOT,'index.html'),'utf-8');

let pass=0,fail=0;
const ok=(c,n)=>{ c?pass++:fail++; console.log((c?"  ✔ ":"  ✘ FAIL: ")+n); };
const tick=(ms)=>new Promise(r=>setTimeout(r,ms||30));

/* file:// 로딩 대신 script src 인라인 치환 (jsdom 리소스 로더 없이 오프라인 로드) */
const engine=fs.readFileSync(path.join(ROOT,'phs-engine.js'),'utf-8');
const reportjs=fs.readFileSync(path.join(ROOT,'phs-report.js'),'utf-8');
/* 5단계에서 처음으로 phsGenBtn까지 실제로 도달해 보니(예전엔 phsStartBtn에서 먼저 죽어서
   몰랐던) phsDaySvg의 그래프 곡선 계산이 simulation-drugmodel.js의 SIMDRUG를 필요로 함이
   드러났다 — pdf-export.test.js에서 이미 쓰던 동일한 인라인 처리를 여기도 추가한다. */
const drugModelJs=fs.readFileSync(path.join(ROOT,'simulation-drugmodel.js'),'utf-8');
const inlined=html
  .replace('<script src="phs-engine.js"></script>',`<script>${engine}</script>`)
  .replace('<script src="phs-report.js"></script>',`<script>${reportjs}</script>`)
  .replace('<script src="simulation-drugmodel.js"></script>',`<script>${drugModelJs}</script>`);

/* 레거시 데이터 사전 주입: PHS 도입 이전 db (phs 키 없음) */
const legacyDb={events:[
  {id:"L1",type:"state",state:"on",ts:Date.now()-86400000*2,output:60,trend:"stable",symptoms:[],customSymptom:""},
  {id:"L2",type:"state",state:"on",ts:Date.now()-86400000*2+3600000,output:null,memo:"legacy ref"},
  {id:"L3",type:"med",drug:"퍼킨",dose:100,ts:Date.now()-86400000*2+1800000},
], meds:[{id:"m1",name:"퍼킨",dose:100,note:"",sched:[]}], settings:{lang:"ko",theme:"light"}, outputChecks:[], dayMemos:{}, questions:[]};

const errs=[];
const dom=new JSDOM(inlined,{runScripts:"dangerously",url:"https://localhost/",pretendToBeVisual:true,
  beforeParse(w){ w.localStorage.setItem("medlog_v1", JSON.stringify(legacyDb));
    ["medlog","yakhyo_v1","medlog_db"].forEach(k=>{}); }});
const w=dom.window, d=w.document;
w.addEventListener("error",e=>errs.push(e.message));

(async ()=>{

console.log("== 로드 & 마이그레이션 ==");
const KEY=w.eval("KEY");
ok(!!KEY,"저장 키 확인: "+KEY);
// 실제 키로 레거시 주입 후 재로드
w.localStorage.setItem(KEY, JSON.stringify(legacyDb));
w.eval("db=load(); renderAll();");
const db=w.eval("db");
ok(db.phs && db.phs.v===1,"load() 시 phs 네임스페이스 자동 마이그레이션");
ok(db.events.length===3 && db.events.some(e=>e.id==="L2"&&e.output===null),"레거시 이벤트(output:null 포함) 무손실 보존");
ok(db.meds.length===1,"약 목록 보존");
w.eval("save()");
const saved=JSON.parse(w.localStorage.getItem(KEY));
ok(saved.phs && saved.events.length===3,"저장 후에도 기존 데이터 + phs 공존");

console.log("== 시드 데이터 (7일 관찰) ==");
w.eval(`
const T=(dd,h,m)=>{const t=new Date();t.setDate(t.getDate()-dd);t.setHours(h,m,0,0);return t.getTime();};
for(let dd=6;dd>=0;dd--){
  db.events.push({id:uid(),type:"state",state:"off",ts:T(dd,7,30),output:25,trend:"stable",symptoms:[],customSymptom:""});
  db.events.push({id:uid(),type:"med",drug:"퍼킨",dose:100,ts:T(dd,8,0)});
  db.events.push({id:uid(),type:"state",state:"on",ts:T(dd,8,50),output:30,trend:"rising",symptoms:[],customSymptom:""});
  db.events.push({id:uid(),type:"state",state:"on",ts:T(dd,9,40),output:55,trend:"rising",symptoms:[],customSymptom:""});
  db.events.push({id:uid(),type:"state",state:"on",ts:T(dd,11,0),output:75,trend:"stable",symptoms:[],customSymptom:""});
  db.events.push({id:uid(),type:"symptom",key:"dysk",ts:T(dd,11,30),phase:"start",customText:"",outputAtStart:75});
  db.events.push({id:uid(),type:"symptom",key:"dysk",ts:T(dd,12,0),phase:"end",outputAtEnd:70});
  db.events.push({id:uid(),type:"state",state:"on",ts:T(dd,13,0),output:60,trend:"falling",symptoms:[],customSymptom:""});
  db.events.push({id:uid(),type:"life",kind:"meal",mealType:"저녁",ts:T(dd,20,30),extras:["단백질 많음"],protein:true});
  db.events.push({id:uid(),type:"state",state:"on",ts:T(dd,17,0),output:50,trend:"falling",symptoms:[],customSymptom:""});
}
db.events.sort((a,b)=>a.ts-b.ts); save(); renderAll();
`);
ok(true,"7일 시드 완료");

console.log("== 1~3단계 흐름 (기본정보 → 기간선택 → 설문) ==");
d.getElementById("phsProfileBtn").click();
ok(!!d.getElementById("ph_save"),"1. 기본 정보 시트 열림");
d.getElementById("ph_years").value="14";
d.getElementById("ph_age").value="60s"; // 현재 <option value>는 코드화된 값(60s) — 화면 표시만 "60대"
d.getElementById("ph_save").click();
ok(w.eval("db.phs.profile.diagnosisYears")===14,"기본 정보 저장");

d.getElementById("phsRangeBtn").click();
ok(!!d.getElementById("pr_save"),"2. 기간 선택 시트 열림(예전 '관찰 시작'을 대체)");
const sd=new Date(); sd.setDate(sd.getDate()-6);
const sdKey=sd.toISOString().slice(0,10), edKey=new Date().toISOString().slice(0,10);
d.getElementById("pr_start").value=sdKey;
d.getElementById("pr_end").value=edKey;
d.getElementById("pr_save").click();
ok(w.eval("db.phs.range.startDate")===sdKey && w.eval("db.phs.range.endDate")===edKey,"보고서 기간 저장");

d.getElementById("phsSurveyBtn").click();
ok(!!d.getElementById("psv_save"),"3. 설문(선택) 시트 열림 — 예전의 시작·종료 설문이 한 화면으로 합쳐짐");
d.querySelector('#ps_primary .chip[data-k="delayed_response"]').click();
d.querySelector('#ps_chief .chip[data-k="delayed_response"]').click();
d.querySelector('#ps_chief .chip[data-k="afternoon_decline"]').click();
d.querySelector('#ps_morn .chip[data-k="60_to_90_min"]').click();
d.getElementById("ps_freeq").value="오후 약을 더 일찍 먹는 것이 좋습니까?";
d.querySelector('#pe_overall .chip[data-k="varied"]').click(); // 예전 '관찰 종료' 설문에 해당하는 부분
d.getElementById("psv_save").click();
const sv=w.eval("db.phs.survey");
ok(sv && sv.start && sv.start.primaryProblem==="delayed_response","설문 저장(예전 '관찰 시작' 쪽 내용)");
ok(sv.start.freeQuestion.includes("일찍"),"자유 질문 원문 보존");
ok(sv.end && sv.end.overallChange==="varied","설문 저장(예전 '관찰 종료' 쪽 내용) — 한 번의 저장으로 함께 기록됨");
/* 예전 phsStartBtn 흐름엔 "가장 큰 어려움을 고르지 않으면 시작 자체가 거부"되는 필수값 검증이
   있었다. 지금 psv_save 핸들러(index.html)에는 그런 차단이 없다 — 설문 전체가 선택 사항이라는
   현재 설계다. 존재하지 않는 옛 차단을 다시 만들어 검사하지 않는다. */

console.log("== 보고서 생성 (다중 페이지) ==");
d.getElementById("phsGenBtn").click();
const ov=d.getElementById("phsOverlay");
ok(ov.classList.contains("open"),"보고서 미리보기 열림");
const txt=ov.textContent;
ok(txt.includes("Patient History Summary"),"제목 렌더");
ok(txt.includes("CC"),"CC 섹션");
ok(txt.includes("파킨슨병 진단 후 약 14년"),"프로필→HPI 반영");
ok(txt.includes("반응 지연 후보")||txt.includes("중앙값"),"약물 반응 분석 문장");
ok(txt.includes("이상운동증"),"증상 분석 반영");
ok(txt.includes("단백질"),"생활 연관성(단백질 식사) 반영");
ok(txt.includes("오후 약을 더 일찍 먹는 것이 좋습니까?"),"환자 자유 질문 그대로 포함");
ok(txt.includes("담당 의료진"),"검토 필요 문구");
ok(txt.includes("자동 생성되었습니다"),"면책 문구");
ok(txt.includes("신뢰도"),"신뢰도 표시");
ok(ov.querySelectorAll("svg").length>=5,"그래프 리뷰 SVG 렌더 ("+ov.querySelectorAll("svg").length+"일)");
ok(ov.querySelectorAll(".phs-page").length===3,"보고서가 3개 phs-page(요약/상세/그래프)로 다중 페이지 구성됨");
// 금지 표현 부재
const banned=[/delayed ON입니다/,/ON failure입니다/,/약을 증량해야/,/약을 감량해야/,/원인입니다/];
ok(!banned.some(p=>p.test(txt)),"보고서에 금지 임상 표현 없음");
// 설문(체감 60~90분) vs 기록(중앙값 ~100분) → agree 판단 검증은 엔진 테스트에서 완료

console.log("== PHS→PDF 버튼 연결 (3/4단계에서 만든 saveFileSafely 경로까지 실제로 이어지는지) ==");
{
  /* html2canvas/jsPDF 자체의 정확도·페이지분할·오프라인 재시도 등 세부 오케스트레이션은
     tests/pdf-export.test.js가 전담한다. 여기서는 "지금의 phsPrintBtn 클릭이 실제로 그
     경로(runPdfExport→exportAsPdf→saveFileSafely)까지 끊기지 않고 연결되는지"만 통합
     관점에서 재확인한다 — 가벼운 스텁으로 html2canvas/jsPDF만 대체한다. */
  w.html2canvas=async(el,opts)=>({
    width:800,height:400,
    getContext:()=>({ getImageData:()=>({ data:new Uint8ClampedArray(3200).fill(255) }) }),
    toDataURL:()=>"data:image/jpeg;base64,ZmFrZQ=="
  });
  class FakeJsPDF{ constructor(o){ this.o=o; this._p=1; } addPage(){ this._p++; } addImage(){} output(t){ return new w.Blob(["FAKE_PHS_PDF"],{type:"application/pdf"}); } }
  w.jspdf={ jsPDF:FakeJsPDF };
  let sharedFile=null;
  w.navigator.canShare=(x)=>!!(x&&x.files&&x.files.length===1);
  w.navigator.share=async(x)=>{ sharedFile=x.files[0]; };
  const printBtn=d.getElementById("phsPrintBtn");
  ok(!!printBtn,"phsPrintBtn이 보고서 툴바에 존재함");
  printBtn.click();
  await tick(150);
  ok(!!sharedFile && sharedFile.type==="application/pdf","phsPrintBtn 클릭 → PDF 생성 → saveFileSafely 공유 경로까지 실제로 연결됨");
  ok(!!sharedFile && /환자병력요약_.*\.pdf$/.test(sharedFile.name),"PHS PDF 파일명 규칙 유지: "+(sharedFile&&sharedFile.name));
}

console.log("== 툴바 기능 ==");
ok(!!d.getElementById("phsPrintBtn") && !!d.getElementById("phsJsonBtn") && !!d.getElementById("phsCopyBtn"),"인쇄/복사/JSON 버튼 존재");
d.getElementById("phsCloseBtn").click();
ok(!ov.classList.contains("open"),"닫기 동작");

console.log("== 기간 선택 없이 빠른 생성 (30일 기본값 fallback) ==");
/* 예전엔 db.phs.observations=[] 로 관찰 자체를 비웠지만, 지금은 그 배열이 쓰이지 않는다(레거시
   read-only 호환용으로만 남음) — 실제로 fallback을 유발하는 것은 db.phs.range를 비우는 것이다. */
w.eval("db.phs.range=null; save();");
d.getElementById("phsGenBtn").click();
ok(ov.classList.contains("open"),"기간을 고르지 않아도 최근 30일 보고서 생성");
ok(ov.textContent.includes("최근 30일 기록으로 생성했어요"),"fallback 안내 문구(예전 14일 → 현재 30일 기본값으로 개편됨)");
d.getElementById("phsCloseBtn").click();

console.log("== 기존 기능 회귀 ==");
w.eval('switchTab("trend")');
ok(d.getElementById("trendZoneLegend").textContent.includes("출력 50~79"),"v0.9.18 체류구간 범례 유지");
ok(d.getElementById("trendOverlayChart").innerHTML.includes("06:00"),"v0.9.18 시간축 유지");
w.eval('switchTab("report")');
ok(d.getElementById("reportBody").textContent.length>0,"기존 보고서 탭 정상");
ok(d.getElementById("tab-report").textContent.includes("이상운동증"),"기존 보고서 증상 표 정상");
w.eval('switchTab("today")');
ok(d.getElementById("outputGraphWrap").innerHTML.includes("var(--dysk)"),"오늘 그래프 증상 막대 유지");
// 기록 수정 종류 변경(0.9.18) 회귀
w.eval('window._s=db.events.find(e=>e.type==="symptom"&&e.phase==="start"); editEvent(window._s);');
ok(!d.getElementById("p_kind").disabled,"기록 수정 종류 선택 활성 유지");
w.eval("closeSheet()");

console.log("== 경계 테스트: 앱 전체 180분 통일 ==");
ok(w.eval("MAX_INTERPOLATION_GAP_MINUTES")===180 && w.eval("PHS.config.maxGapMin")===180 && w.eval("MAX_INTERPOLATION_GAP_MINUTES===PHS.config.maxGapMin"),"index.html 상수가 PHS.config에서 파생(180)");
{ const dwell=G=>w.eval(`(()=>{ // 체류시간: 10:00 기록 후 G분 뒤 기록 하나
    const dk="2026-07-01";
    const t=(h,m)=>new Date(2026,6,1,h,m,0).getTime();
    const ev=[{id:"b1",type:"state",state:"on",ts:t(10,0),output:85,trend:"stable"},
              {id:"b2",type:"state",state:"on",ts:t(10+Math.floor(${G}/60),${G}%60),output:85,trend:"stable"}];
    return dayOutputStats(ev,dk); })()`);
  const d179=dwell(179), d180=dwell(180), d181=dwell(181);
  ok(d179.zones.z80>=179+180-1 && d180.zones.z80>=180+180-1,"179·180분 간격 → 체류시간에 전부 귀속(미기록 아님)");
  ok(d181.zones.z80<=180+180 && d181.unrecorded>=181-1,"181분 간격 → 귀속 없이 미기록 처리");
}
ok(ov0Legend(),"보고서 범례 문구가 '3시간 초과 공백'으로 표기");
function ov0Legend(){ d.getElementById("phsGenBtn").click(); const t=d.getElementById("phsOverlay").textContent; const okk=t.includes("3시간 초과 공백")&&!t.includes("2시간 초과"); d.getElementById("phsCloseBtn").click(); return okk; }
ok(w.eval("db.phs && db.phs.v===1"),"경계 테스트 후 데이터 무손상");

console.log("== 네트워크 격리 ==");
const allSrc=engine+reportjs+fs.readFileSync(path.join(ROOT,'index.html'),'utf-8');
const uiBlock=allSrc.slice(allSrc.indexOf("Patient History Summary UI"));
ok(!/fetch\(|XMLHttpRequest|sendBeacon|WebSocket/.test(engine+reportjs+uiBlock.slice(0,uiBlock.indexOf("/Patient History Summary UI"))),"PHS 코드에 네트워크 API 없음");

console.log("== JSON 백업 호환 ==");
const backup=w.eval("JSON.stringify(db)");
const re=JSON.parse(backup);
ok(re.events.length===w.eval("db.events.length") && re.phs.profile.diagnosisYears===14,"백업 JSON에 phs 포함, 이벤트 무결");

console.log("== v0.9.20 안정화·영문화 ==");
{ const src=fs.readFileSync(path.join(ROOT,'index.html'),'utf-8');
  ok(/user-scalable=yes/.test(src) && /maximum-scale=5\.0/.test(src) && !/user-scalable=no/.test(src), "viewport 확대 허용(user-scalable=yes, max 5.0)");
  ok(/@page\{\s*size:A4;\s*margin:12mm\s*\}/.test(src), "A4 12mm @page 인쇄 규격");
  ok(/break-inside:avoid/.test(src) && /page-break-inside:avoid/.test(src), "표·그래프 페이지 잘림 방지 CSS");
  const pv=fs.readFileSync(path.join(ROOT,'privacy.html'),'utf-8');
  ok(/user-scalable=yes/.test(pv), "privacy.html viewport 확대 허용"); }
/* 글씨 크기: 저장·적용 */
w.eval(`db.settings.fontScale=1.3; save(); applyFontScale();`);
ok(JSON.parse(w.localStorage.getItem(KEY)).settings.fontScale===1.3, "글씨 크기 설정 저장(1.3)");
ok(d.documentElement.style.getPropertyValue("--app-font-scale").trim()==="1.3", "CSS 변수 --app-font-scale 적용");
w.eval(`db.settings.fontScale=1; save(); applyFontScale();`);
/* 출력 점수 가이드 */
w.eval("openOutputGuide()");
{ const tt=d.querySelector(".sheet").textContent;
  ok(tt.includes("90~100")&&tt.includes("개인 기준"), "출력 점수 기준 안내 + 면책 문구");
  w.eval("closeSheet()"); }
/* 주증상 최대 3개 구조 */
w.eval(`db.primarySymptoms=[{id:"psym_tremor",type:"tremor",label:"떨림",active:true,createdAt:new Date().toISOString()}]; save();`);
ok(JSON.parse(w.localStorage.getItem(KEY)).primarySymptoms.length===1, "primarySymptoms 저장 구조 동작");
/* 영문 보고서 전수 검사 */
w.eval(`db.settings.lang="en"; save();`);
d.getElementById("phsGenBtn").click();
{ const ov=d.getElementById("phsOverlay");
  const rep=w.eval("JSON.stringify(window.__phsLastReport||null)");
  let txt=ov.textContent;
  /* 사용자 입력 원문(약 이름·자유 질문)은 보존 대상 → 검사에서 제외 */
  const allow=["퍼킨","오후 약을 더 일찍","저녁마다 발가락"];
  allow.forEach(a=>{ txt=txt.split(a).join(""); });
  const hangul=(txt.match(/[가-힣]+/g)||[]);
  ok(hangul.length===0, "영문 보고서에 한국어 고정 문구 없음 ("+hangul.slice(0,5).join(",")+")");
  ok(ov.textContent.includes("Patient History Summary") && ov.textContent.includes("Points for Clinical Review"), "영문 섹션 제목 정상");
  ok(!/has Delayed ON|diagnosed/i.test(ov.textContent), "영문 금지 표현 없음");
  d.getElementById("phsCloseBtn").click(); }
w.eval(`db.settings.lang="ko"; save();`);
/* 언어 전환 후 데이터 유지 */
ok(w.eval("db.events.length>0 && db.phs && db.phs.v===1 && db.meds.length>0"), "언어 전환 후 기존 데이터 유지");

console.log("== window errors ==");
ok(errs.length===0,"콘솔/윈도우 에러 0건 ("+errs.join("; ")+")");

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);

})().catch(e=>{ console.error("TEST HARNESS ERROR:", e); process.exit(1); });
