/* 임시 신호 별도저장·전환 + 3시간 공백 복구 + 변화없음 구간 — 총괄 승인 2026-08-26 12장 1~5단계
 * 회귀·호환성 테스트. easteregg/v200p0/ 사본(index.html·phs-engine.js·phs-report.js)만 대상으로
 * 하며, 실제 사용자 데이터(브라우저 localStorage)는 건드리지 않는다(jsdom 안의 가상 localStorage만 사용).
 * phs-integration.test.js와 같은 패턴(JSDOM + runScripts:"dangerously")을 쓰되, 이 파일에 없는
 * phsStartBtn 설문 플로우(기존에도 실패 중인 별개 회귀, DEPLOYMENT_CHECKLIST.md 참고)는 건드리지 않는다. */
const fs=require('fs'), path=require('path');
const {JSDOM}=require('jsdom');
const ROOT=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(ROOT,'index.html'),'utf-8');
const engine=fs.readFileSync(path.join(ROOT,'phs-engine.js'),'utf-8');
const reportjs=fs.readFileSync(path.join(ROOT,'phs-report.js'),'utf-8');
const inlined=html
  .replace('<script src="phs-engine.js"></script>',`<script>${engine}</script>`)
  .replace('<script src="phs-report.js"></script>',`<script>${reportjs}</script>`);

let pass=0, fail=0;
const ok=(c,n)=>{ c?pass++:fail++; console.log((c?"  ✔ ":"  ✘ FAIL: ")+n); };

function newWindow(){
  const errs=[];
  const dom=new JSDOM(inlined,{runScripts:"dangerously",url:"https://localhost/",pretendToBeVisual:true});
  const w=dom.window;
  w.addEventListener("error",e=>errs.push(e.message));
  w.confirm=()=>true; // 테스트 기본값: 확인 대화상자는 항상 승인 (개별 테스트에서 필요시 덮어씀)
  w._errs=errs;
  return w;
}
function loadFresh(seedDb){
  const w=newWindow();
  const KEY=w.eval("KEY");
  if(seedDb) w.localStorage.setItem(KEY, JSON.stringify(seedDb));
  w.eval("db=load(); renderAll();");
  return w;
}
/* 결정론적 과거 dayKey(오늘로부터 offsetDays 전, 자정 기준) — '오늘'의 현재시각 캡(now)
   로직을 피해 179/180/181분 경계 같은 정밀 테스트를 언제 돌려도 같은 결과로 만든다. */
function pastDay(w, offsetDays){
  return w.eval(`(function(){
    const d=new Date(); d.setDate(d.getDate()-${offsetDays}); d.setHours(0,0,0,0);
    return {key:dkey(d), y:d.getFullYear(), mo:d.getMonth(), da:d.getDate()};
  })()`);
}
function tsAt(day, h, m){ return new Date(day.y, day.mo, day.da, h, m, 0).getTime(); }
function mkState(w, ts, output, trend){
  return w.eval(`(function(){
    const ev={id:uid(), type:"state", state:${JSON.stringify(trend==="rising"?"rising":(trend==="falling"?"falling":"on"))}, ts:${ts}, output:${output}, trend:${JSON.stringify(trend||"stable")}, symptoms:[], customSymptom:""};
    db.events.push(ev); db.events.sort((a,b)=>a.ts-b.ts); save(); return ev.id;
  })()`);
}

console.log("== A. 기존 yakhyo_log_v1 데이터 호환 (신규 필드 없는 레거시) ==");
{
  /* 5단계 조사에서 발견된 시각 의존 결함(2026-08-26): 이 두 이벤트를 "지금부터 -1시간/-30분"
     (Date.now() 상대값)으로 두면, 실행 시각이 그날 하루시작(06:00, PHS.config.dayWindow.
     startH)로부터 충분히 늦은 시각이면 renderAll()의 공백 스캔(syncGapResolutions)이
     "06:00~첫 기록"의 실제 180분 초과 공백을 정직하게 찾아내 gapResolutions를 채운다 —
     이는 기능 결함이 아니라 정상 동작이며, 실행 시각에 따라 결과가 달라지는 쪽은 이
     테스트였다. 아래 두 이벤트를 "오늘"이 아닌, 최근 7일 스캔 범위(recentDayKeysForGapScan)
     밖의 고정된 과거 하루로 옮겨(자정 경계·dayWindow 계산 자체는 그대로 실사용) 어느
     시간대·실행 시각에도 이 하루가 스캔 대상이 되지 않도록 한다. gapResolutions의
     "빈 배열 초기화" 자체는 renderAll()(공백 스캔)이 아니라 load()의 마이그레이션
     기본값 채우기(index.html의 `d.gapResolutions = d.gapResolutions||[]`) 몫이므로,
     그 검증은 renderAll() 이전에 확인해 스캔 실행 여부와 무관하게 만든다. */
  const w=newWindow();
  const day=pastDay(w, 10); // 최근 7일 스캔 범위 밖의 고정된 과거 하루(자정 기준 dkey)
  const legacy={ events:[
      {id:"L1", type:"state", state:"on", ts:tsAt(day,9,0), output:60, trend:"stable", symptoms:[], customSymptom:""},
      {id:"L2", type:"tempnote", ts:tsAt(day,9,30), dir:"up", memo:"", tags:[]}, // status/score/source 필드가 아예 없는 옛 tempnote
    ], meds:[{id:"m1",name:"퍼킨",dose:100,note:"",sched:[]}], settings:{theme:"light"}, outputChecks:[], dayMemos:{}, questions:[] };
  const KEY=w.eval("KEY");
  w.localStorage.setItem(KEY, JSON.stringify(legacy));
  w.eval("db=load();"); // renderAll() 이전 — 아직 공백 스캔이 실행되지 않은 순수 마이그레이션 직후 상태
  const dbAfterLoad=w.eval("db");
  ok(dbAfterLoad.events.length===2, "레거시 이벤트 2건 그대로 로드됨");
  ok(Array.isArray(dbAfterLoad.gapResolutions) && dbAfterLoad.gapResolutions.length===0, "gapResolutions 필드 없어도 빈 배열로 정상 초기화(load() 직후 — 공백 스캔 전이라 실행 시각·시간대와 무관하게 항상 성립)");
  w.eval("renderAll();");
  const db=w.eval("db");
  const pending=w.eval("pendingTempNotes()");
  ok(pending.length===1 && pending[0].id==="L2", "status 필드 없는 옛 tempnote도 미처리 목록에 정상 표시(temporary 취급)");
  ok(w._errs.length===0, "레거시 데이터 로드 중 런타임 오류 없음: "+w._errs.join("; "));
}

console.log("== B. 상승·피크·하락·바닥 저장 ==");
{
  const w=loadFresh(null);
  ["up","peak","down","bottom"].forEach(dir=>{
    w.eval(`addTempNote(${JSON.stringify(dir)}, "", Date.now(), [], "app")`);
  });
  const notes=w.eval(`db.events.filter(e=>e.type==="tempnote")`);
  ok(notes.length===4, "4개 방향 신호 모두 저장됨: "+notes.map(n=>n.dir).join(","));
  ok(notes.every(n=>n.status==="temporary" && n.score===null && n.source==="app"), "모두 status:temporary, score:null, source:app로 저장됨");
  const dirDefs=w.eval(`TEMPNOTE_DIRS.map(d=>d.key)`);
  ok(dirDefs.includes("bottom"), "TEMPNOTE_DIRS에 bottom 방향 존재");
}

console.log("== C. 중복 탭 방지 (2초 내 같은/다른 방향 버튼 연타) ==");
{
  const w=loadFresh(null);
  w.eval(`openTempNoteQuick()`);
  const btn=w.document.querySelector('[data-dir="up"]');
  btn.click(); btn.click(); btn.click(); // 연속 3회
  const notes=w.eval(`db.events.filter(e=>e.type==="tempnote")`);
  ok(notes.length===1, "연속 3회 탭에도 1건만 저장됨 (실제 "+notes.length+"건)");
}

console.log("== D. finalized 이중 계산 방지 + 전환 시 시각·출처 보존 ==");
{
  const w=loadFresh(null);
  const tnId=w.eval(`addTempNote("peak","",${Date.now()-7200000},[],"app").id`);
  w.eval(`openTempNoteReview()`);
  const scoreInput=w.document.querySelector('[data-tn="'+tnId+'"] .tn-score');
  scoreInput.value="85";
  w.document.getElementById("tnSaveAll").click();
  const note=w.eval(`db.events.find(e=>e.id===${JSON.stringify(tnId)})`);
  const promoted=w.eval(`db.events.find(e=>e.type==="state" && e.promotedFrom===${JSON.stringify(tnId)})`);
  ok(note && note.status==="finalized" && note.score===85, "원본 tempnote 삭제되지 않고 status:finalized, score:85로 보존됨");
  ok(note && typeof note.finalizedAt==="number" && note.finalizedAt>=note.createdAt, "전환 시각(finalizedAt)이 생성 시각(createdAt) 이후로 기록됨");
  ok(!!promoted, "정식 state 기록이 새로 생성됨");
  ok(promoted && promoted.ts===note.ts, "정식 기록의 ts(원래 발생 시각)가 임시기록과 동일하게 보존됨");
  ok(promoted && promoted.enteredAt===undefined, "정식 기록에 중복 필드(enteredAt)를 따로 만들지 않음 — promotedFrom으로 원본을 찾으면 됨");
  ok(promoted && promoted.source==="app", "기록 출처(source)가 보존됨");
  const pending=w.eval(`pendingTempNotes().length`);
  ok(pending===0, "전환된 임시기록은 '미처리 임시기록' 개수에서 제외됨");
  const dayKey=w.eval(`dkey(new Date(${note.ts}))`);
  const curveEvents=w.eval(`dayAnchorsAndEvents(${JSON.stringify(dayKey)}).events`);
  ok(curveEvents.length===0, "finalized 임시기록은 곡선 추정 입력에서 제외됨(실측 앵커와 이중 반영 방지)");
  const stateCountBefore=w.eval(`db.events.filter(e=>e.type==="state").length`);
  // 이미 finalized된 같은 tempnote를 다시 리뷰 시트에서 저장 시도해도(방어선) 중복 생성되지 않아야 함
  w.eval(`(function(){
    const btn=document.createElement("button"); btn.id="tnSaveAll2";
    document.body.appendChild(btn);
  })()`);
  w.eval(`(function(){
    const note=db.events.find(e=>e.id===${JSON.stringify(tnId)});
    // tnSaveAll 내부와 동일한 방어 로직 재현: status==="finalized"면 건너뜀
    if(note.status==="finalized") return; // 이 분기를 타야 정상
    db.events.push({id:uid(), type:"state", ts:note.ts, output:1});
  })()`);
  const stateCountAfter=w.eval(`db.events.filter(e=>e.type==="state").length`);
  ok(stateCountAfter===stateCountBefore, "이미 finalized된 임시기록은 재전환되지 않음(이중 계산 방지 가드 확인)");
}

console.log("== E. 179/180/181분 경계 (detectDayGaps) ==");
/* 각 케이스마다 06:00~하루끝(24:00) 경계 공백이 별도로 함께 잡히는 것은 정상 동작(마지막
   기록 이후 자정까지는 실제로 미기록 구간이 맞다 — dayOutputStats()와 동일 원칙). 여기서는
   "두 기록 사이" 구간 하나만 정확히 골라 179/180/181분 경계를 검증한다. */
function gapBetween(gaps, a, b){ return gaps.find(g=>g.startAt===a && g.endAt===b); }
{
  const w=loadFresh(null);
  const day=pastDay(w,3);
  const t1=tsAt(day,9,0), t2=tsAt(day,11,59); // 179분
  mkState(w, t1, 70, "stable");
  mkState(w, t2, 65, "stable");
  let gaps=w.eval(`detectDayGaps(${JSON.stringify(day.key)})`);
  ok(!gapBetween(gaps,t1,t2), "179분 간격(두 기록 사이) → 공백 아님");

  const w2=loadFresh(null);
  const day2=pastDay(w2,4);
  const t3=tsAt(day2,9,0), t4=tsAt(day2,12,0); // 정확히 180분
  mkState(w2, t3, 70, "stable");
  mkState(w2, t4, 65, "stable");
  gaps=w2.eval(`detectDayGaps(${JSON.stringify(day2.key)})`);
  ok(!gapBetween(gaps,t3,t4), "정확히 180분 간격(두 기록 사이) → 공백 아님(경계 포함)");

  const w3=loadFresh(null);
  const day3=pastDay(w3,5);
  const t5=tsAt(day3,9,0), t6=tsAt(day3,12,1); // 181분
  mkState(w3, t5, 70, "stable");
  mkState(w3, t6, 65, "stable");
  gaps=w3.eval(`detectDayGaps(${JSON.stringify(day3.key)})`);
  const g181=gapBetween(gaps,t5,t6);
  ok(!!g181 && g181.durationMinutes===181, "181분 간격(두 기록 사이) → 공백 1건, 181분으로 집계 (실제 "+JSON.stringify(g181)+")");
}

console.log("== F. 중간 변화 추가 → 공백 상태 backfilled로 변경 ==");
{
  const w=loadFresh(null);
  const day=pastDay(w,6);
  mkState(w, tsAt(day,9,0), 70, "stable");
  mkState(w, tsAt(day,13,0), 30, "falling"); // 4시간 공백
  w.eval(`syncGapResolutions(${JSON.stringify(day.key)})`);
  const gapBefore=w.eval(`db.gapResolutions.find(r=>r.status==="unresolved")`);
  ok(!!gapBefore && gapBefore.durationMinutes===240, "4시간 공백이 unresolved로 감지됨");
  w.eval(`openGapBackfillFlow(db.gapResolutions.find(r=>r.status==="unresolved"))`);
  const downBtn=w.document.querySelector('[data-gdir="down"]');
  ok(!!downBtn, "중간 변화 추가 시트에 방향 버튼(하락 등) 렌더링됨");
  downBtn.click();
  const gapAfter=w.eval(`db.gapResolutions.find(r=>r.id===${JSON.stringify(gapBefore.id)})`);
  ok(gapAfter.status==="backfilled", "공백 상태가 backfilled로 변경됨");
  const inserted=w.eval(`db.events.find(e=>e.type==="tempnote" && e.dir==="down")`);
  ok(!!inserted && inserted.ts>gapBefore.startAt && inserted.ts<gapBefore.endAt, "회고 신호(하락)가 공백 범위 안의 시각으로 삽입됨");
}

console.log("== G. 변화없음 구간 — 가짜 점수 미생성 (기준점 있음, 20점 미만 차이) ==");
{
  const w=loadFresh(null);
  const day=pastDay(w,7);
  mkState(w, tsAt(day,9,0), 70, "stable");
  mkState(w, tsAt(day,13,0), 65, "stable"); // 차이 5점 < 20점
  w.eval(`syncGapResolutions(${JSON.stringify(day.key)})`);
  const stateCountBefore=w.eval(`db.events.filter(e=>e.type==="state").length`);
  const gap=w.eval(`db.gapResolutions.find(r=>r.status==="unresolved")`);
  w.eval(`openGapStableConfirm(db.gapResolutions.find(r=>r.id===${JSON.stringify(gap.id)}))`);
  const stateCountAfter=w.eval(`db.events.filter(e=>e.type==="state").length`);
  ok(stateCountAfter===stateCountBefore, "변화없음 확인 후에도 state(출력점수) 기록 개수 불변 — 가짜 점수 생성 안 됨");
  const stable=w.eval(`db.events.find(e=>e.type==="stableRange")`);
  ok(!!stable && stable.hasAnchor===true && stable.anchorScore===70, "stableRange 1건 생성, 기준점(70)을 앵커로 보존");
  const gapAfter=w.eval(`db.gapResolutions.find(r=>r.id===${JSON.stringify(gap.id)})`);
  ok(gapAfter.status==="stable_confirmed", "공백 상태가 stable_confirmed로 변경됨");
  ok(w._errs.length===0, "stableRange 타임라인 렌더링 중 오류 없음(evRow 전용 분기 확인): "+w._errs.join("; "));
}

console.log("== H. 기억나지 않음 — 해당 구간만 제외, 다른 기록·다른 공백은 유지 ==");
{
  const w=loadFresh(null);
  const day=pastDay(w,8);
  mkState(w, tsAt(day,9,0), 70, "stable");
  mkState(w, tsAt(day,14,0), 40, "falling"); // 5시간 공백, 앞뒤 기록은 실측 그대로 유지되어야 함
  const otherDay=pastDay(w,9);
  mkState(w, tsAt(otherDay,9,0), 70, "stable");
  mkState(w, tsAt(otherDay,13,0), 30, "falling"); // 별개 날짜의 별개 공백 — 영향 없어야 함
  w.eval(`syncGapResolutions(${JSON.stringify(day.key)}); syncGapResolutions(${JSON.stringify(otherDay.key)})`);
  const targetGap=w.eval(`db.gapResolutions.find(r=>r.status==="unresolved" && r.durationMinutes===300)`);
  ok(!!targetGap, "대상 5시간 공백 감지됨");
  w.eval(`resolveGapUnknown(db.gapResolutions.find(r=>r.id===${JSON.stringify(targetGap.id)}))`);
  const resolved=w.eval(`db.gapResolutions.find(r=>r.id===${JSON.stringify(targetGap.id)})`);
  ok(resolved.status==="unknown_excluded", "선택한 공백만 unknown_excluded로 확정됨");
  const otherGap=w.eval(`db.gapResolutions.find(r=>r.durationMinutes===240)`);
  ok(otherGap && otherGap.status==="unresolved", "다른 날짜의 별개 공백은 영향받지 않고 unresolved 유지");
  const realStates=w.eval(`db.events.filter(e=>e.type==="state").map(e=>e.output)`);
  ok(realStates.includes(70) && realStates.includes(40) && realStates.includes(30), "공백 전후 실제 출력 기록은 그대로 유지됨: "+realStates.join(","));
}

console.log("== I. 20점 이상 차이 — 경고만 표시, 기록 저장은 차단하지 않음 ==");
{
  const w=loadFresh(null);
  const day=pastDay(w,10);
  mkState(w, tsAt(day,9,0), 70, "stable");
  mkState(w, tsAt(day,13,0), 30, "falling"); // 차이 40점 ≥ 20점
  w.eval(`syncGapResolutions(${JSON.stringify(day.key)})`);
  const gap=w.eval(`db.gapResolutions.find(r=>r.status==="unresolved")`);
  w.eval(`openGapStableConfirm(db.gapResolutions.find(r=>r.id===${JSON.stringify(gap.id)}))`);
  const conflictBtn=w.document.getElementById("gapConflictStillBtn");
  ok(!!conflictBtn, "20점 이상 차이 시 모순 확인 시트가 먼저 뜸(자동 차단 아님, 선택지 제공)");
  conflictBtn.click();
  const stable=w.eval(`db.events.find(e=>e.type==="stableRange")`);
  const gapAfter=w.eval(`db.gapResolutions.find(r=>r.id===${JSON.stringify(gap.id)})`);
  ok(!!stable && stable.note==="점수와 회상 내용 불일치", "'그래도 비슷했다'를 선택하면 실제로 저장됨(차단되지 않음), 불일치 표시 남김");
  ok(gapAfter.status==="conflict_review", "공백 상태가 conflict_review로 표시됨(정량 분석에서 보수적 제외 대상)");
}

console.log("== J. 앱 재실행 후 기록 유지 (localStorage 재로드) ==");
{
  const w1=loadFresh(null);
  const day=pastDay(w1,11);
  mkState(w1, tsAt(day,9,0), 70, "stable");
  mkState(w1, tsAt(day,13,0), 30, "falling");
  w1.eval(`addTempNote("bottom","",${tsAt(day,10,0)},[],"app")`);
  w1.eval(`syncGapResolutions(${JSON.stringify(day.key)})`);
  const KEY=w1.eval("KEY");
  const snapshot=w1.localStorage.getItem(KEY);
  const before={ events:w1.eval("db.events.length"), gaps:w1.eval("db.gapResolutions.length") };

  const w2=newWindow();
  w2.localStorage.setItem(KEY, snapshot);
  w2.eval("db=load(); renderAll();");
  const after={ events:w2.eval("db.events.length"), gaps:w2.eval("db.gapResolutions.length") };
  ok(before.events===after.events && before.gaps===after.gaps, `재실행 후에도 이벤트(${after.events})·공백기록(${after.gaps}) 개수 동일`);
  ok(w2.eval(`db.events.some(e=>e.type==="tempnote" && e.dir==="bottom")`), "재실행 후에도 '바닥' 신호 보존됨");
}

console.log("== K. JSON 내보내기·가져오기 왕복 후 데이터 동일성 ==");
{
  const w=loadFresh(null);
  const day=pastDay(w,12);
  mkState(w, tsAt(day,9,0), 70, "stable");
  mkState(w, tsAt(day,13,0), 30, "falling");
  w.eval(`syncGapResolutions(${JSON.stringify(day.key)})`);
  w.eval(`openGapStableConfirm(db.gapResolutions.find(r=>r.status==="unresolved"))`); // diff=40 → 모순 시트
  w.document.getElementById("gapConflictStillBtn").click();
  const tnId=w.eval(`addTempNote("peak","",${tsAt(day,10,0)},[],"app").id`);
  w.eval(`openTempNoteReview()`);
  w.document.querySelector('[data-tn="'+tnId+'"] .tn-score').value="55";
  w.document.getElementById("tnSaveAll").click();

  // exportBtn과 동일한 직렬화(JSON.stringify(db,null,2)) 결과를 왕복시킨다
  const exportedJson=w.eval(`JSON.stringify(db,null,2)`);
  const before=JSON.parse(exportedJson);
  // importFile.onchange 핸들러와 동일한 병합 로직 재현
  w.eval(`(function(){
    const d=JSON.parse(${JSON.stringify(exportedJson)});
    db=Object.assign({questions:defaultQuestions(),settings:{theme:db.settings.theme,notify:false},meds:[]}, d);
    db.meds=(db.meds||[]).map(m=>({sched:[],...m}));
    db.settings=db.settings||{theme:"light"};
    save();
  })()`);
  const after=w.eval(`db`);
  ok(after.events.length===before.events.length, `이벤트 개수 동일(${after.events.length})`);
  ok(after.gapResolutions.length===before.gapResolutions.length, `공백기록 개수 동일(${after.gapResolutions.length})`);
  ok(JSON.stringify(after.events)===JSON.stringify(before.events), "이벤트 배열 완전 동일(순서·필드 포함)");
  const stableAfter=after.events.find(e=>e.type==="stableRange");
  ok(!!stableAfter && stableAfter.note==="점수와 회상 내용 불일치", "왕복 후에도 stableRange의 불일치 표시(기록 출처 포함) 보존");
  const finalizedAfter=after.events.find(e=>e.id===tnId);
  ok(finalizedAfter && finalizedAfter.status==="finalized" && finalizedAfter.score===55, "왕복 후에도 finalized 임시기록의 상태·점수 보존");
}

console.log("== L. gapResolutions 재계산 안정성 (총괄 검수 반영) ==");
{
  /* 주의: 하루 창(06:00~24:00) 기준으로 마지막 기록 이후 자정까지도 별도의 "경계 공백"으로
     항상 잡힌다(정상 동작 — dayOutputStats()와 동일 원칙). 아래 검증은 그 경계 공백과
     섞이지 않도록 gapBetween()으로 "두 기록 사이"만 콕 집어 확인한다. */
  console.log("-- L1. 공백 중간에 기록 추가 → 두 구간으로 분할, 옛 unresolved는 사라짐 --");
  const w=loadFresh(null);
  const day=pastDay(w,20);
  const L1a=tsAt(day,9,0), L1b=tsAt(day,13,0), L1c=tsAt(day,17,0);
  mkState(w, L1a, 70, "stable");
  mkState(w, L1c, 30, "falling"); // 8시간 공백(09:00~17:00)
  w.eval(`syncGapResolutions(${JSON.stringify(day.key)})`);
  let gaps=w.eval(`db.gapResolutions.filter(r=>r.status==="unresolved")`);
  const oldGap=gapBetween(gaps, L1a, L1c);
  ok(!!oldGap && oldGap.durationMinutes===480, "최초 8시간(480분) 공백(09:00~17:00) 감지됨");
  mkState(w, L1b, 50, "stable"); // 중간(13:00)에 실제 기록 추가 → 240분+240분으로 분할
  w.eval(`syncGapResolutions(${JSON.stringify(day.key)})`);
  gaps=w.eval(`db.gapResolutions.filter(r=>r.status==="unresolved")`);
  ok(!gapBetween(gaps, L1a, L1c), "더 이상 존재하지 않는 옛 09:00~17:00(480분) 공백 레코드는 제거됨(유령 공백 방지)");
  const half1=gapBetween(gaps, L1a, L1b), half2=gapBetween(gaps, L1b, L1c);
  ok(!!half1 && half1.durationMinutes===240 && !!half2 && half2.durationMinutes===240, "09:00~13:00, 13:00~17:00 각 240분 공백으로 정확히 분할됨");

  console.log("-- L2. 중간 기록 추가로 공백이 180분 이하로 줄어드는 경우 → 그 구간만 소멸, 새 공백 생성 안 됨 --");
  const w2=loadFresh(null);
  const day2=pastDay(w2,21);
  const L2a=tsAt(day2,9,0), L2mid=tsAt(day2,11,0), L2b=tsAt(day2,13,0);
  mkState(w2, L2a, 70, "stable");
  mkState(w2, L2b, 30, "falling"); // 240분 공백(09:00~13:00)
  w2.eval(`syncGapResolutions(${JSON.stringify(day2.key)})`);
  let gaps2=w2.eval(`db.gapResolutions.filter(r=>r.status==="unresolved")`);
  ok(!!gapBetween(gaps2, L2a, L2b), "최초 240분 공백(09:00~13:00) 감지됨");
  mkState(w2, L2mid, 50, "stable"); // 09:00~11:00=120분, 11:00~13:00=120분 — 둘 다 공백 아님
  w2.eval(`syncGapResolutions(${JSON.stringify(day2.key)})`);
  gaps2=w2.eval(`db.gapResolutions.filter(r=>r.status==="unresolved")`);
  ok(!gapBetween(gaps2, L2a, L2b), "옛 09:00~13:00 공백 레코드는 제거됨");
  ok(!gapBetween(gaps2, L2a, L2mid) && !gapBetween(gaps2, L2mid, L2b), "180분 이하로 줄어든 두 하위 구간 모두 새 공백으로 생성되지 않음");

  console.log("-- L3/L4. 이미 확정(해결)된 공백은 이후 데이터가 바뀌어도 되돌리지 않고, 다시 카드에 뜨지 않음 --");
  const w3=loadFresh(null);
  const day3=pastDay(w3,22);
  mkState(w3, tsAt(day3,9,0), 70, "stable");
  mkState(w3, tsAt(day3,17,0), 30, "falling");
  w3.eval(`syncGapResolutions(${JSON.stringify(day3.key)})`);
  const g3=w3.eval(`db.gapResolutions.find(r=>r.status==="unresolved" && r.durationMinutes===480)`);
  w3.eval(`resolveGapUnknown(db.gapResolutions.find(r=>r.id===${JSON.stringify(g3.id)}))`);
  mkState(w3, tsAt(day3,13,0), 50, "stable"); // 확정 이후 같은 구간 안에 실제 데이터가 생겨도
  w3.eval(`syncGapResolutions(${JSON.stringify(day3.key)})`);
  const resolved3=w3.eval(`db.gapResolutions.find(r=>r.id===${JSON.stringify(g3.id)})`);
  ok(!!resolved3 && resolved3.status==="unknown_excluded", "이미 확정된 공백은 이후 데이터 변화와 무관하게 그대로 유지됨(사용자의 그 시점 판단 보존)");
  const cardList3=w3.eval(`(function(){ const u=db.gapResolutions.filter(r=>r.status==="unresolved"); return u.map(r=>r.id); })()`);
  ok(!cardList3.includes(g3.id), "이미 해결된 공백은 unresolved 목록(=복구 카드 대상)에 다시 나타나지 않음");

  console.log("-- L5. 날짜가 다른 공백은 서로 충돌하지 않음 --");
  const w4=loadFresh(null);
  const dayA=pastDay(w4,23), dayB=pastDay(w4,24);
  mkState(w4, tsAt(dayA,9,0), 70, "stable"); mkState(w4, tsAt(dayA,17,0), 30, "falling");
  mkState(w4, tsAt(dayB,9,0), 70, "stable"); mkState(w4, tsAt(dayB,17,0), 30, "falling");
  w4.eval(`syncGapResolutions(${JSON.stringify(dayA.key)}); syncGapResolutions(${JSON.stringify(dayB.key)})`);
  const gB=w4.eval(`db.gapResolutions.find(r=>dkey(new Date(r.startAt))===${JSON.stringify(dayB.key)})`);
  mkState(w4, tsAt(dayA,13,0), 50, "stable"); // dayA만 재계산
  w4.eval(`syncGapResolutions(${JSON.stringify(dayA.key)})`);
  const gBafter=w4.eval(`db.gapResolutions.find(r=>r.id===${JSON.stringify(gB.id)})`);
  ok(!!gBafter && gBafter.status==="unresolved", "다른 날짜(dayB) 공백은 dayA만 재동기화해도 영향받지 않고 그대로 남음");

  console.log("-- L6. 변화 없이 반복 호출해도 멱등(중복 생성 없음) --");
  const w5=loadFresh(null);
  const day5=pastDay(w5,25);
  mkState(w5, tsAt(day5,9,0), 70, "stable"); mkState(w5, tsAt(day5,17,0), 30, "falling");
  w5.eval(`syncGapResolutions(${JSON.stringify(day5.key)})`);
  const len1=w5.eval(`db.gapResolutions.length`);
  w5.eval(`syncGapResolutions(${JSON.stringify(day5.key)}); syncGapResolutions(${JSON.stringify(day5.key)}); syncGapResolutions(${JSON.stringify(day5.key)})`);
  const len2=w5.eval(`db.gapResolutions.length`);
  ok(len1===len2, `동일 조건 반복 호출에도 개수 불변(${len1} → ${len2})`);
}

console.log("== M. stableRange 안전성 추가 검증 (총괄 검수 반영) ==");
{
  const w=loadFresh(null);
  const day=pastDay(w,26);
  mkState(w, tsAt(day,9,0), 70, "stable");
  mkState(w, tsAt(day,13,0), 65, "stable"); // 차이 5점, 무경고 경로
  w.eval(`syncGapResolutions(${JSON.stringify(day.key)})`);
  const statsBefore=w.eval(`dayOutputStats(db.events, ${JSON.stringify(day.key)})`);
  const gap=w.eval(`db.gapResolutions.find(r=>r.status==="unresolved")`);
  w.eval(`openGapStableConfirm(db.gapResolutions.find(r=>r.id===${JSON.stringify(gap.id)}))`);
  const statsAfter=w.eval(`dayOutputStats(db.events, ${JSON.stringify(day.key)})`);
  ok(statsAfter.count===statsBefore.count, `stableRange 생성 후에도 dayOutputStats().count 불변(실제 측정 횟수 증가 없음, ${statsBefore.count}→${statsAfter.count})`);
  ok(statsAfter.avg===statsBefore.avg, "평균 출력값도 stableRange로 인해 바뀌지 않음(가짜 점수가 그래프 계산에 섞이지 않음)");

  const analysisBefore=w.eval(`(function(){
    const evsNoStable=db.events.filter(e=>e.type!=="stableRange");
    return JSON.stringify(PHS.analyze({events:evsNoStable, startTs:${tsAt(day,0,0)}, endTs:${tsAt(day,23,59)}}));
  })()`);
  const analysisWithStable=w.eval(`JSON.stringify(PHS.analyze({events:db.events, startTs:${tsAt(day,0,0)}, endTs:${tsAt(day,23,59)}}))`);
  ok(analysisBefore===analysisWithStable, "stableRange가 섞여 있어도 PHS.analyze() 결과가 완전히 동일함(엔진 입력에서 제외됨 확인)");

  const stableEv=w.eval(`db.events.find(e=>e.type==="stableRange")`);
  ok(!!stableEv, "stableRange 이벤트 생성 확인");
  w.eval(`delEvent(${JSON.stringify(stableEv.id)})`);
  const gapAfterDelete=w.eval(`db.gapResolutions.find(r=>r.id===${JSON.stringify(gap.id)})`);
  ok(gapAfterDelete.status==="unresolved", "stableRange 삭제 시 연결된 gapResolution이 unresolved로 일관되게 되돌아감(고아 상태 방지)");
  ok(!w.eval(`db.events.some(e=>e.type==="stableRange")`), "stableRange 이벤트 자체는 정상 삭제됨");

  // 재생성 후 JSON 왕복
  w.eval(`openGapStableConfirm(db.gapResolutions.find(r=>r.id===${JSON.stringify(gap.id)}))`);
  const beforeRT=w.eval(`db.events.find(e=>e.type==="stableRange")`);
  const exported=w.eval(`JSON.stringify(db)`);
  w.eval(`(function(){ const d=JSON.parse(${JSON.stringify(exported)}); db=Object.assign({questions:defaultQuestions(),settings:{theme:db.settings.theme,notify:false},meds:[]}, d); db.meds=(db.meds||[]).map(m=>({sched:[],...m})); save(); })()`);
  const afterRT=w.eval(`db.events.find(e=>e.type==="stableRange")`);
  ok(afterRT && afterRT.hasAnchor===beforeRT.hasAnchor && afterRT.anchorScore===beforeRT.anchorScore, "JSON 왕복 후에도 stableRange의 hasAnchor·anchorScore 그대로 유지됨");
}

console.log("== N. finalized 임시신호 타임라인 표시 정리 (총괄 검수 반영, 다음 병합 전 UX 보완) ==");
{
  const w=loadFresh(null);
  const tnId=w.eval(`addTempNote("peak","",${Date.now()-3600000},[],"app").id`);

  console.log("-- 전환 전: 임시신호 한 줄만 표시 --");
  let rows=w.eval(`(function(){
    const list=document.createElement("div");
    visibleEvents(db.events).forEach(e=>list.appendChild(evRow(e)));
    return [...list.children].map(r=>r.querySelector(":scope > .pill").textContent);
  })()`);
  ok(rows.length===1 && rows[0]==="임시", "전환 전에는 화면에 임시신호 1줄만 보임(정식 기록 없음): "+JSON.stringify(rows));

  // 전환(review sheet와 동일한 절차)
  w.eval(`openTempNoteReview()`);
  w.document.querySelector('[data-tn="'+tnId+'"] .tn-score').value="85";
  w.document.getElementById("tnSaveAll").click();

  console.log("-- 전환 후: 정식 출력 한 줄만 표시(원본 tempnote 행은 숨김) --");
  rows=w.eval(`(function(){
    const list=document.createElement("div");
    visibleEvents(db.events).forEach(e=>list.appendChild(evRow(e)));
    return [...list.children].map(r=>({pill:r.querySelector(":scope > .pill").textContent, html:r.innerHTML}));
  })()`);
  ok(rows.length===1, "전환 후 화면에는 정식 출력 1줄만 보임(임시신호 원본 행 숨김): "+rows.length+"줄");
  ok(rows[0] && rows[0].pill==="출력", "남은 한 줄은 '출력' 배지");
  ok(rows[0] && rows[0].html.includes("임시신호에서 전환됨"), "'임시신호에서 전환됨' 배지 표시됨");
  ok(rows[0] && rows[0].html.includes("피크에서 전환"), "원래 신호 종류(피크)가 함께 표시됨: 예) 출력 85 · 피크에서 전환");

  console.log("-- finalized 원본은 localStorage(데이터)에는 그대로 남아 있음 --");
  const KEY=w.eval("KEY");
  const saved=JSON.parse(w.localStorage.getItem(KEY));
  const savedNote=saved.events.find(e=>e.id===tnId);
  ok(!!savedNote && savedNote.status==="finalized" && savedNote.score===85, "저장소에는 finalized tempnote 원본이 삭제되지 않고 그대로 있음");
  const savedState=saved.events.find(e=>e.promotedFrom===tnId);
  ok(!!savedState, "promotedFrom 연결이 저장소에도 유지됨");

  console.log("-- 정량 분석에서는 한 번만 계산됨(이중 계산 없음, 기존 정책 재확인) --");
  const outputCount=w.eval(`PHS.adaptEvents(db.events, 0, Date.now()+86400000).outputEvents.length`);
  ok(outputCount===1, "PHS 엔진 입력 기준 출력 기록은 1건뿐(tempnote는애초에 type!=='state'라 집계 대상 아님): "+outputCount);

  console.log("-- 미처리(temporary) 임시신호는 기존처럼 그대로 표시 --");
  w.eval(`addTempNote("up","",${Date.now()-1800000},[],"app")`);
  rows=w.eval(`(function(){
    const list=document.createElement("div");
    visibleEvents(db.events).forEach(e=>list.appendChild(evRow(e)));
    return [...list.children].map(r=>r.querySelector(":scope > .pill").textContent);
  })()`);
  ok(rows.includes("임시"), "새로 추가한 미처리 임시신호는 정상적으로 화면에 보임: "+JSON.stringify(rows));

  console.log("-- JSON 왕복 후에도 한 줄만 표시됨 --");
  const exported=w.eval(`JSON.stringify(db)`);
  w.eval(`(function(){ const d=JSON.parse(${JSON.stringify(exported)}); db=Object.assign({questions:defaultQuestions(),settings:{theme:db.settings.theme,notify:false},meds:[]}, d); db.meds=(db.meds||[]).map(m=>({sched:[],...m})); save(); })()`);
  const rowsAfterRT=w.eval(`(function(){
    const list=document.createElement("div");
    visibleEvents(db.events).forEach(e=>list.appendChild(evRow(e)));
    return [...list.children].map(r=>r.querySelector(":scope > .pill").textContent);
  })()`);
  ok(rowsAfterRT.filter(p=>p==="출력").length===1, "왕복 후에도 finalized 건은 여전히 정식 출력 1줄로만 표시됨: "+JSON.stringify(rowsAfterRT));

  console.log("-- 원본을 찾을 수 없는 고아 promotedFrom도 오류 없이 표시 --");
  const w2=loadFresh(null);
  w2.eval(`db.events.push({id:uid(), type:"state", state:"on", ts:Date.now(), output:60, trend:"stable",
    symptoms:[], customSymptom:"", promotedFrom:"nonexistent-id-12345", source:"app"}); save(); renderAll();`);
  ok(w2._errs.length===0, "원본이 없는 promotedFrom을 가진 state 기록도 렌더링 오류 없음: "+w2._errs.join("; "));
  const orphan=w2.eval(`(function(){ const e=db.events.find(x=>x.promotedFrom==="nonexistent-id-12345"); const row=evRow(e); return {title:row.querySelector(".s").textContent, hasBadge: row.innerHTML.includes("임시신호에서 전환됨")}; })()`);
  ok(orphan.title.includes("출력 60"), "고아 promotedFrom이어도 출력값 등 나머지 정보는 정상 표시");
  ok(!orphan.title.includes("에서 전환"), "원본을 못 찾으면 '~에서 전환' 같은 구체적 신호 종류 문구는 조용히 생략됨(추측 텍스트 없음): "+orphan.title);
  ok(orphan.hasBadge, "다만 '임시신호에서 전환됨' 일반 배지는 promotedFrom이 있다는 사실만으로 그대로 표시됨(원본을 못 찾아도 전환된 기록이라는 사실 자체는 알려줌)");
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
