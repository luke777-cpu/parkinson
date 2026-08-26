/* =====================================================================
 * phs-engine.js — Patient History Summary Engine (v1)
 * ---------------------------------------------------------------------
 * 약효일지에 통합되는 로컬 보고서 엔진.
 * 아키텍처 (MASTER_SPEC §5):
 *   Raw Data → [adapt] → Analysis Engine → Confidence Engine
 *            → Report Engine (+templatesKo) → Safety Filter → Renderer
 *
 * 규칙:
 *  - 원자료(raw record)에서 직접 문장을 만들지 않는다. 분석 결과(JSON)만 문장화한다.
 *  - 분석 함수는 구조화된 JSON만 반환한다.
 *  - 보고서 엔진은 임상 분석을 재계산하지 않는다.
 *  - 언어 템플릿(templatesKo)은 분석 코드와 분리한다.
 *  - 모든 처리는 브라우저 로컬에서만 수행한다. 네트워크 요청 없음.
 *  - 결측 구간은 결측으로 남긴다. 긴 공백을 가짜 값으로 메우지 않는다.
 * ===================================================================== */
(function(global){
"use strict";

const PHS = {};
PHS.SCHEMA_VERSION = 1;

/* ---------- 설정 (후보 규칙 임계값 — REPORT_ENGINE_SPEC §7, 조정 가능) ---------- */
PHS.config = {
  riseThreshold: 20,        // 의미 있는 출력 상승 (§7.1)
  delayedMinutes: 60,       // 반응 지연 후보 기준 (§7.2)
  postDoseWindowMin: 180,   // 복용 후 관찰 창
  preDoseWindowMin: 90,     // 복용 전 출력 탐색 창
  /* ---- 공백 관련 임계값 2종 — 반드시 이 한 곳(PHS.config)에서만 관리, 서로 통일하지 않는다
     (총괄 승인 2026-08-26 ②) ----
     - preNoticeMinutes(120=2시간): "사전 안내"만. 강제 아님, 분석 제외·상태 저장 없음.
       index.html의 curveGapNoticeHtml()이 참조한다.
     - maxGapMin(180=3시간): "공백 판정·복구 대상". 초과(>180)만 공백, 180 정확히는 공백 아님.
       index.html의 gapResolutions/복구 카드, 그리고 아래 그래프·체류시간·약물반응·
       신뢰도·보고서 전체가 이 값 하나만 참조한다. */
  preNoticeMinutes: 120,    // ★ 2시간 — 사전 안내 전용 임계값(공백 판정과 무관)
  maxGapMin: 180,           // ★ 3시간 — 미기록(공백) 판단 공통 기준(분).
                            //   초과(>180)만 미기록, 180 정확히는 미기록 아님.
  highPreDose: 70,          // 복용 전 출력이 이미 높으면 평가 제외
  rescueWindowMin: 60,      // 이 안에 추가 복용이 있으면 평가 제외
  confoundMealBeforeMin: 60,// 복용 전 60분 내 식사 → 귀속 불명확
  confoundMealAfterMin: 30, // 복용 후 30분 내 식사 → 귀속 불명확
  incompleteMargin: 15,     // 개인 기대치 대비 이만큼 못 미치면 불완전 후보
  wearingOffDrop: 15,       // 다음 복용 전 하강 후보 기준
  wearingOffPreMin: 90,     // 다음 복용 전 탐색 창
  dayWindow: {startH: 6, endH: 24}, // 분석 시간대 (기존 앱과 동일)
};

/* ---------- 공용 유틸 (엔진 독립 실행을 위해 자체 구현) ---------- */
function dkeyOf(ts){ const d=new Date(ts); const p=n=>String(n).padStart(2,"0"); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`; }
function hmOf(ts){ const d=new Date(ts); const p=n=>String(n).padStart(2,"0"); return `${p(d.getHours())}:${p(d.getMinutes())}`; }
function median(a){ if(!a.length) return null; const s=[...a].sort((x,y)=>x-y); const m=Math.floor(s.length/2); return s.length%2? s[m] : Math.round((s[m-1]+s[m])/2); }
function mean(a){ return a.length? a.reduce((x,y)=>x+y,0)/a.length : null; }
function sd(a){ if(a.length<2) return null; const m=mean(a); return Math.sqrt(a.reduce((s,v)=>s+(v-m)*(v-m),0)/(a.length-1)); }
function clamp(v,lo,hi){ return Math.max(lo,Math.min(hi,v)); }
PHS._util={dkeyOf,hmOf,median,mean,sd};

/* ---------- 마이그레이션 (명시적·가역적) ----------
 * 기존 db 객체에 db.phs 네임스페이스만 추가한다. 기존 키(events/meds/settings/
 * outputChecks/dayMemos/questions)는 절대 수정하지 않는다.
 * 롤백: db.phs 키 삭제 또는 백업 JSON 복원만으로 이전 상태와 동일해진다. */
PHS.migrate = function(db){
  if(!db || typeof db!=="object") return {migrated:false, db};
  if(db.phs && db.phs.v===PHS.SCHEMA_VERSION) return {migrated:false, db};
  if(!db.phs){
    db.phs = { v:PHS.SCHEMA_VERSION, profile:null, observations:[] };
    return {migrated:true, db};
  }
  // 향후 버전 업그레이드 지점 (현재 v1만 존재)
  db.phs.v = PHS.SCHEMA_VERSION;
  db.phs.profile = db.phs.profile||null;
  db.phs.observations = db.phs.observations||[];
  return {migrated:true, db};
};

/* ---------- Raw Data 어댑터 ----------
 * 기존 약효일지 이벤트 스키마(type:"state"/"med"/"symptom"/"life")를
 * 분석 입력 형태로 변환한다. 기존 데이터를 수정하지 않는다(읽기 전용). */
PHS.adaptEvents = function(events, startTs, endTs){
  const inRange = e => e.ts>=startTs && e.ts<endTs;
  const src = (events||[]).filter(inRange).slice().sort((a,b)=>a.ts-b.ts);
  const outputEvents = src.filter(e=>e.type==="state" && Number.isFinite(e.output))
    .map(e=>({id:e.id, ts:e.ts, output:e.output, trend:e.trend||null,
              retrospective:!!e.retrospective, inputMethod:e.inputMethod||null}));
  const medicationEvents = src.filter(e=>e.type==="med")
    .map(e=>({id:e.id, ts:e.ts, name:e.drug||"", doseMg:e.dose??null}));
  /* 증상: 시작/종료 쌍을 묶어 duration 산출. 종료 없는 시작은 duration:null */
  const symptomEvents=[];
  const byKey={};
  src.filter(e=>e.type==="symptom").forEach(e=>{ (byKey[e.key]||(byKey[e.key]=[])).push(e); });
  Object.entries(byKey).forEach(([key,list])=>{
    let open=null;
    list.forEach(e=>{
      if(e.phase==="start"){
        if(open) symptomEvents.push(open); // 종료 없이 재시작 → 이전 것 duration:null
        open={id:e.id, ts:e.ts, key, outputAtStart:e.outputAtStart??null,
              customText:e.customText||"", durationMinutes:null};
      } else if(e.phase==="end"){
        if(open){ open.durationMinutes=Math.round((e.ts-open.ts)/60000); symptomEvents.push(open); open=null; }
      }
    });
    if(open) symptomEvents.push(open);
  });
  symptomEvents.sort((a,b)=>a.ts-b.ts);
  const lifestyleEvents = src.filter(e=>e.type==="life")
    .map(e=>({id:e.id, ts:e.ts, kind:e.kind, phase:e.phase||null, mealType:e.mealType||null,
              extras:e.extras||[], quality:e.quality||[], consistency:e.consistency||null,
              amount:e.amount||null, intensity:e.intensity||null}));
  return {outputEvents, medicationEvents, symptomEvents, lifestyleEvents};
};

/* ---------- Gap 분석 ---------- */
function findGaps(outputEvents, startTs, endTs, cfg){
  const gaps=[]; const gapMs=cfg.maxGapMin*60000;
  const days={};
  outputEvents.forEach(e=>{ (days[dkeyOf(e.ts)]||(days[dkeyOf(e.ts)]=[])).push(e); });
  Object.entries(days).forEach(([k,list])=>{
    const [Y,M,D]=k.split("-").map(Number);
    const winS=new Date(Y,M-1,D,cfg.dayWindow.startH,0,0).getTime();
    const winE=new Date(Y,M-1,D,cfg.dayWindow.endH,0,0).getTime();
    const pts=[winS, ...list.map(e=>e.ts), winE].sort((a,b)=>a-b);
    for(let i=0;i<pts.length-1;i++){
      const g=pts[i+1]-pts[i];
      if(g>gapMs) gaps.push({day:k, from:pts[i], to:pts[i+1], minutes:Math.round(g/60000)});
    }
  });
  return gaps;
}

/* ---------- 출력 분석 ---------- */
function analyzeOutput(adapted, startTs, endTs, cfg){
  const outs=adapted.outputEvents;
  const vals=outs.map(e=>e.output);
  const byDayV={};
  outs.forEach(e=>{ (byDayV[dkeyOf(e.ts)]||(byDayV[dkeyOf(e.ts)]=[])).push(e.output); });
  const dayKeys=Object.keys(byDayV).sort();
  const dailyRanges=dayKeys.map(k=>Math.max(...byDayV[k])-Math.min(...byDayV[k]));
  const dailyMaxima=dayKeys.map(k=>Math.max(...byDayV[k]));
  /* 시간대별 (2시간 버킷, 06~24시) */
  const buckets={};
  outs.forEach(e=>{
    const h=new Date(e.ts).getHours();
    if(h<cfg.dayWindow.startH||h>=cfg.dayWindow.endH) return;
    const b=cfg.dayWindow.startH + Math.floor((h-cfg.dayWindow.startH)/2)*2;
    (buckets[b]||(buckets[b]=[])).push(e.output);
  });
  const bucketStats=Object.entries(buckets).map(([b,arr])=>({
    label:`${String(b).padStart(2,"0")}:00-${String(+b+2).padStart(2,"0")}:00`,
    n:arr.length, avg:Math.round(mean(arr)), sd:sd(arr)
  })).sort((a,b)=>a.label.localeCompare(b.label));
  const evaluable=bucketStats.filter(b=>b.n>=3 && b.sd!=null);
  const mostStable = evaluable.length? [...evaluable].sort((a,b)=>a.sd-b.sd)[0].label : null;
  const mostVariable = evaluable.length? [...evaluable].sort((a,b)=>b.sd-a.sd)[0].label : null;
  const gaps=findGaps(outs, startTs, endTs, cfg);
  const missingMinutes=gaps.reduce((s,g)=>s+g.minutes,0);
  return {
    average: vals.length? Math.round(mean(vals)) : null,
    median: median(vals),
    minimum: vals.length? Math.min(...vals) : null,
    maximum: vals.length? Math.max(...vals) : null,
    averageDailyRange: dailyRanges.length? Math.round(mean(dailyRanges)) : null,
    timeOfDayAverages: bucketStats.map(({label,n,avg})=>({label,n,avg})),
    mostStablePeriod: mostStable,
    mostVariablePeriod: mostVariable,
    personalPeakMedian: median(dailyMaxima), // 개인 기대치 (불완전 후보 판정용)
    unrecordedGaps: gaps,
    missingMinutes,
  };
}

/* ---------- 약물 반응 분석 ---------- */
function analyzeMedicationResponse(adapted, cfg, personalPeak){
  const outs=adapted.outputEvents, meds=adapted.medicationEvents;
  const perDose=[];
  const medsByDay={};
  meds.forEach(m=>{ (medsByDay[dkeyOf(m.ts)]||(medsByDay[dkeyOf(m.ts)]=[])).push(m); });
  meds.forEach(m=>{
    const dayMeds=medsByDay[dkeyOf(m.ts)];
    const isMorningFirst = dayMeds[0].id===m.id;
    const preWinS=m.ts-cfg.preDoseWindowMin*60000;
    const postWinE=m.ts+cfg.postDoseWindowMin*60000;
    const pre=outs.filter(e=>e.ts>=preWinS && e.ts<=m.ts);
    const post=outs.filter(e=>e.ts>m.ts && e.ts<=postWinE);
    const rec={doseId:m.id, name:m.name, ts:m.ts, day:dkeyOf(m.ts), isMorningFirst,
      preOutput:null, postPeak:null, riseMinutes:null, riseMagnitude:null,
      evaluable:false, exclusionReason:null,
      delayedCandidate:false, incompleteCandidate:false, noClearResponseCandidate:false};
    if(!pre.length){ rec.exclusionReason="no_pre_dose_output"; perDose.push(rec); return; }
    rec.preOutput=pre[pre.length-1].output;
    if(!post.length){ rec.exclusionReason="no_post_dose_output"; perDose.push(rec); return; }
    /* 관찰 창 내부 공백 검사.
       의미 있는 상승이 이미 관찰된 경우에는 상승 시점까지만 검사하고,
       상승이 없으면 창 종료 시점까지 검사한다 — 기록이 끊긴 뒤의 공백을
       "반응 없음"으로 오판하지 않기 위함 (결측은 결측으로 남긴다). */
    const riseProbe=post.find(e=>e.output>=pre[pre.length-1].output+cfg.riseThreshold);
    const gapEnd = riseProbe? riseProbe.ts : postWinE;
    const pts=[m.ts, ...post.map(e=>e.ts).filter(t=>t<=gapEnd), gapEnd];
    let hasGap=false;
    for(let i=0;i<pts.length-1;i++) if(pts[i+1]-pts[i]>cfg.maxGapMin*60000){ hasGap=true; break; }
    if(hasGap){ rec.exclusionReason="long_gap_in_window"; perDose.push(rec); return; }
    if(rec.preOutput>=cfg.highPreDose){ rec.exclusionReason="pre_dose_output_already_high"; perDose.push(rec); return; }
    const rescue=meds.find(x=>x.id!==m.id && x.ts>m.ts && x.ts<=m.ts+cfg.rescueWindowMin*60000);
    if(rescue){ rec.exclusionReason="another_dose_in_window"; perDose.push(rec); return; }
    const confMeal=adapted.lifestyleEvents.find(l=>l.kind==="meal"
      && l.ts>=m.ts-cfg.confoundMealBeforeMin*60000 && l.ts<=m.ts+cfg.confoundMealAfterMin*60000);
    const confEx=adapted.lifestyleEvents.find(l=>l.kind==="exercise"
      && l.ts>=m.ts && l.ts<=m.ts+cfg.confoundMealAfterMin*60000);
    rec.confounded = !!(confMeal||confEx);
    rec.postPeak=Math.max(...post.map(e=>e.output));
    rec.riseMagnitude=rec.postPeak-rec.preOutput;
    const riseEv=post.find(e=>e.output>=rec.preOutput+cfg.riseThreshold);
    rec.riseMinutes = riseEv? Math.round((riseEv.ts-m.ts)/60000) : null;
    rec.evaluable=true;
    if(rec.confounded){
      /* 시간적 귀속이 불명확 — 평가 가능 수에는 포함하되 후보 분류에서는 제외 */
      rec.exclusionReason="confounded_by_meal_or_exercise";
      perDose.push(rec); return;
    }
    if(rec.riseMinutes!=null){
      if(rec.riseMinutes>cfg.delayedMinutes) rec.delayedCandidate=true;
      if(personalPeak!=null && rec.postPeak < personalPeak - cfg.incompleteMargin) rec.incompleteCandidate=true;
    } else {
      /* 상승 없음: 충분한 관찰 창(마지막 기록이 90분 이후) + 공백 없음일 때만 */
      const lastPost=post[post.length-1];
      if(lastPost.ts-m.ts>=90*60000) rec.noClearResponseCandidate=true;
      else rec.exclusionReason="observation_window_too_short";
    }
    perDose.push(rec);
  });
  /* 웨어링오프 후보: 다음 복용 전 하강 반복 (§7.5) */
  const woEvents=[];
  const medsSorted=[...meds].sort((a,b)=>a.ts-b.ts);
  for(let i=0;i<medsSorted.length-1;i++){
    const cur=medsSorted[i], next=medsSorted[i+1];
    if(dkeyOf(cur.ts)!==dkeyOf(next.ts)) continue;
    const win=outs.filter(e=>e.ts>=next.ts-cfg.wearingOffPreMin*60000 && e.ts<next.ts);
    if(win.length<2) continue;
    const drop=win[0].output - win[win.length-1].output;
    if(drop>=cfg.wearingOffDrop) woEvents.push({day:dkeyOf(next.ts), beforeDoseAt:hmOf(next.ts), hour:new Date(next.ts).getHours(), drop});
  }
  const woByHour={};
  woEvents.forEach(w=>{ for(const h of [w.hour-1,w.hour,w.hour+1]) woByHour[h]=(woByHour[h]||0)+0; woByHour[w.hour]=(woByHour[w.hour]||0)+1; });
  const woDays=new Set(woEvents.map(w=>w.day));
  const recurrentHour=Object.entries(woByHour).filter(([h,c])=>c>=2).map(([h])=>+h);
  const wearingOffCandidate = woDays.size>=2 && woEvents.length>=2;
  /* v0.9.20: 약별 대표 복용 시각 (일중 순번별 중앙값 분) */
  const schedByName={};
  Object.values(medsByDay).forEach(list=>{
    list.forEach((m2,idx)=>{
      const k=m2.name; (schedByName[k]||(schedByName[k]={dose:m2.doseMg,slots:{}}));
      const mins=new Date(m2.ts).getHours()*60+new Date(m2.ts).getMinutes();
      (schedByName[k].slots[idx]||(schedByName[k].slots[idx]=[])).push(mins);
    });
  });
  const doseSchedule=Object.entries(schedByName).map(([name,v])=>({
    name, doseMg:v.dose,
    times:Object.keys(v.slots).sort((a,b)=>a-b).map(i=>{
      const mm=median(v.slots[i]); return `${String(Math.floor(mm/60)).padStart(2,"0")}:${String(mm%60).padStart(2,"0")}`;
    })
  }));
  const morning=perDose.filter(r=>r.isMorningFirst);
  const morningEval=morning.filter(r=>r.evaluable && !r.confounded);
  return {
    perDose,
    totalDoses: meds.length,
    morningFirstDose: {
      doses: morning.length,
      evaluableDoses: morningEval.length,
      medianRiseMinutes: median(morningEval.map(r=>r.riseMinutes).filter(v=>v!=null)),
      delayedCandidates: morningEval.filter(r=>r.delayedCandidate).length,
      incompleteCandidates: morningEval.filter(r=>r.incompleteCandidate).length,
      noClearResponseCandidates: morningEval.filter(r=>r.noClearResponseCandidate).length,
    },
    allDoses: {
      evaluableDoses: perDose.filter(r=>r.evaluable && !r.confounded).length,
      delayedCandidates: perDose.filter(r=>r.delayedCandidate).length,
      incompleteCandidates: perDose.filter(r=>r.incompleteCandidate).length,
      noClearResponseCandidates: perDose.filter(r=>r.noClearResponseCandidate).length,
      excluded: perDose.filter(r=>!r.evaluable || r.confounded).map(r=>({doseId:r.doseId, reason:r.exclusionReason})),
    },
    wearingOff: { candidate: wearingOffCandidate, events: woEvents, recurrentHours: recurrentHour, days: woDays.size },
    doseSchedule,
  };
}

/* ---------- 증상 분석 ---------- */
const SYMPTOM_LABELS = {
  dysk:{ko:"이상운동증",en:"Dyskinesia"}, dyst:{ko:"근긴장이상",en:"Dystonia"},
  freeze:{ko:"동결보행",en:"Freezing of Gait"}, tremor:{ko:"떨림",en:"Tremor"},
  brady:{ko:"서동",en:"Bradykinesia"}, other:{ko:"기타 증상",en:"Other symptom"}};
PHS.symptomLabel = (key,lang)=> (SYMPTOM_LABELS[key]||{})[lang==="en"?"en":"ko"] || key;
function analyzeSymptoms(adapted, cfg){
  const outs=adapted.outputEvents, meds=adapted.medicationEvents;
  const outAt=ts=>{ const prior=outs.filter(e=>e.ts<=ts); return prior.length? prior[prior.length-1].output : null; };
  const trendAt=ts=>{ const prior=outs.filter(e=>e.ts<=ts); return prior.length? prior[prior.length-1].trend : null; };
  const minutesFromLastDose=ts=>{ const prior=meds.filter(m=>m.ts<=ts); return prior.length? Math.round((ts-prior[prior.length-1].ts)/60000) : null; };
  const byKey={};
  adapted.symptomEvents.forEach(e=>{ (byKey[e.key]||(byKey[e.key]=[])).push(e); });
  const result={};
  Object.entries(byKey).forEach(([key,list])=>{
    const outsAtEv=list.map(e=>e.outputAtStart??outAt(e.ts)).filter(v=>v!=null);
    const durs=list.map(e=>e.durationMinutes).filter(v=>v!=null);
    const trends=list.map(e=>trendAt(e.ts)).filter(Boolean);
    const hours=list.map(e=>new Date(e.ts).getHours());
    const fromDose=list.map(e=>minutesFromLastDose(e.ts)).filter(v=>v!=null);
    /* 관계 분류 (기술적 표현만, §7.6~7.7) */
    let relation="insufficient_data";
    if(outsAtEv.length>=2){
      const avg=mean(outsAtEv);
      const rising=trends.filter(t=>t==="rising").length, falling=trends.filter(t=>t==="falling").length;
      if(avg>=65) relation="high_output_associated";
      else if(avg<=40) relation="low_output_associated";
      else if(rising>falling && rising>=2) relation="rising_phase_associated";
      else if(falling>rising && falling>=2) relation="falling_phase_associated";
      else relation="mixed";
      if(key==="dyst" && hours.filter(h=>h<10).length>=Math.ceil(hours.length*0.6)) relation="morning_associated";
    }
    result[key]={
      key, labelKo: (SYMPTOM_LABELS[key]||{}).ko||key,
      count: list.length,
      averageOutputAtEvent: outsAtEv.length? Math.round(mean(outsAtEv)) : null,
      medianDurationMinutes: median(durs),
      relation,
      medianMinutesFromLastDose: median(fromDose),
    };
  });
  return result;
}

/* ---------- 생활 분석 (시간적 연관성만) ---------- */
function analyzeLifestyle(adapted){
  const life=adapted.lifestyleEvents;
  const days=new Set(adapted.outputEvents.map(e=>dkeyOf(e.ts)));
  const meals=life.filter(l=>l.kind==="meal");
  const proteinMeals=meals.filter(l=>(l.extras||[]).includes("단백질 많음"));
  const lateMeals=meals.filter(l=>new Date(l.ts).getHours()>=20);
  const POOR=["뒤척임 많음","잠들기 어려움","자주 깸","악몽","수면 부족"];
  const poorSleepDays=new Set(life.filter(l=>l.kind==="sleep"&&(l.quality||[]).some(q=>POOR.includes(q))).map(l=>dkeyOf(l.ts)));
  const constipationDays=new Set(life.filter(l=>l.kind==="bowel"&&(l.consistency==="딱딱함"||(l.extras||[]).includes("힘들었음"))).map(l=>dkeyOf(l.ts)));
  const exercise=life.filter(l=>l.kind==="exercise");
  const assoc=[];
  if(proteinMeals.length) assoc.push({factor:"high_protein_meal", labelKo:"단백질 많은 식사", relationship:"temporal_association_only", supportingEvents:proteinMeals.length});
  if(lateMeals.length) assoc.push({factor:"late_meal", labelKo:"늦은 시간 식사", relationship:"temporal_association_only", supportingEvents:lateMeals.length});
  if(poorSleepDays.size) assoc.push({factor:"poor_sleep", labelKo:"수면의 질 저하", relationship:"temporal_association_only", supportingEvents:poorSleepDays.size});
  if(constipationDays.size) assoc.push({factor:"constipation", labelKo:"변비 의심 배변", relationship:"temporal_association_only", supportingEvents:constipationDays.size});
  return {
    mealCount:meals.length, proteinMealCount:proteinMeals.length, lateMealCount:lateMeals.length,
    poorSleepDays:poorSleepDays.size, constipationDays:constipationDays.size,
    exerciseCount:exercise.length, associations:assoc,
  };
}

/* ---------- 분석 엔진 (총괄) ---------- */
PHS.analyze = function({events, startTs, endTs, config}){
  const cfg=Object.assign({}, PHS.config, config||{});
  const adapted=PHS.adaptEvents(events, startTs, endTs);
  const output=analyzeOutput(adapted, startTs, endTs, cfg);
  const medicationResponse=analyzeMedicationResponse(adapted, cfg, output.personalPeakMedian);
  const symptoms=analyzeSymptoms(adapted, cfg);
  const lifestyle=analyzeLifestyle(adapted);
  const recordedDaySet=new Set(adapted.outputEvents.map(e=>dkeyOf(e.ts)));
  const periodDays=Math.max(1, Math.round((endTs-startTs)/86400000));
  return {
    schemaVersion: PHS.SCHEMA_VERSION,
    period:{ start:dkeyOf(startTs), end:dkeyOf(endTs-1), periodDays,
             recordedDays:recordedDaySet.size, totalOutputRecords:adapted.outputEvents.length,
             totalMedicationRecords:adapted.medicationEvents.length },
    output, medicationResponse, symptoms, lifestyle,
    _adapted: adapted, // 신뢰도 엔진용 내부 참조 (보고서 엔진은 사용 금지)
  };
};

/* ---------- 신뢰도 엔진 ---------- */
PHS.assessConfidence = function(analysis, startSurvey){
  const reasons=[]; let score=50; const R=(code,params)=>reasons.push({code,params:params||{}});
  const p=analysis.period, o=analysis.output, mr=analysis.medicationResponse;
  const adapted=analysis._adapted;
  const perDay = p.recordedDays? analysis.period.totalOutputRecords/p.recordedDays : 0;
  if(p.recordedDays>=5){ score+=10; R("days_recorded",{p:p.periodDays,d:p.recordedDays}); }
  if(p.recordedDays<3){ score-=15; R("few_days",{d:p.recordedDays}); }
  if(perDay>=5){ score+=10; R("good_daily_rate",{n:Math.round(perDay)}); }
  if(perDay<3 && p.recordedDays>0){ score-=10; R("low_daily_rate",{n:perDay.toFixed(1)}); }
  if(p.totalMedicationRecords>0){ score+=10; }
  else { score-=10; R("no_med_times"); }
  const evalRatio = mr.totalDoses? mr.allDoses.evaluableDoses/mr.totalDoses : 0;
  if(mr.totalDoses>0 && evalRatio>=0.5){ score+=10; R("good_dose_coverage"); }
  else if(mr.totalDoses>0 && evalRatio<0.3){ score-=5; R("low_dose_coverage"); }
  /* unrecordedGaps는 이미 공통 기준(maxGapMin 초과)으로만 수집됨 */
  const gapHours=Math.round(PHS.config.maxGapMin/60);
  if(o.unrecordedGaps.length>p.recordedDays){ score-=10; R("frequent_gaps",{h:gapHours}); }
  const retro=adapted.outputEvents.filter(e=>e.retrospective).length;
  if(adapted.outputEvents.length && retro/adapted.outputEvents.length>0.5){ score-=10; R("high_retrospective"); }
  /* 설문-기록 일치 여부 */
  let agreement="not_assessed";
  if(startSurvey && startSurvey.perceivedMorningResponse && mr.morningFirstDose.medianRiseMinutes!=null){
    const perceivedSlow = /60|90|120|이상|slow/.test(String(startSurvey.perceivedMorningResponse));
    const observedSlow = mr.morningFirstDose.medianRiseMinutes>60;
    if(perceivedSlow===observedSlow){ score+=5; agreement="agree"; R("survey_agree"); }
    else { score-=5; agreement="conflict"; R("survey_conflict"); }
  }
  score=clamp(Math.round(score),0,100);
  const level=s=>s>=75?"high":(s>=50?"moderate":"low");
  const secOut = p.totalOutputRecords>=15? "high" : (p.totalOutputRecords>=6? "moderate":"low");
  const secMed = mr.allDoses.evaluableDoses>=4? "high" : (mr.allDoses.evaluableDoses>=2? "moderate":"low");
  const secLife = analysis.lifestyle.associations.length && p.recordedDays>=5? "moderate":"low";
  return { overall:level(score), score, reasons, surveyAgreement:agreement,
    sectionConfidence:{ outputSummary:secOut, medicationResponse:secMed, lifestyleAssociation:secLife } };
};

global.PHS = PHS;
})(typeof window!=="undefined"? window : globalThis);
