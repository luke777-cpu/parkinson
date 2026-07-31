/* ============================================================
   simulation-clinical.js — 기간 기반 임상 문제 판별 엔진 (v0.9.26)
   책임: 최근 N일 실제 기록에서 같은 성격의 복용을 그룹으로 묶고,
   각 복용 사례의 ON latency·유효 ON 도달·최고 출력을 계산해
   delayed ON / incomplete ON / ON failure "후보"를 분류한다.

   중요:
   - 여기의 분류는 확정 진단이 아니라 앱 내부 패턴 탐지 규칙이다.
   - 절대 기준만 쓰지 않고 그 사람의 평소 반응(중앙값)과 비교한다.
   - 기록이 부족한 사례는 판정하지 않고 "판정 불가"로 남긴다.
   - DOM·localStorage에 의존하지 않는다 (Node 단독 테스트 가능).
   ============================================================ */
(function(root){
"use strict";
const CLIN = {};

CLIN.DEFAULTS = {
  effectiveOnOutput: 80,      /* 유효 ON 기준 출력 (개인 기준으로 바꿀 수 있음) */
  windowBeforeMin: 90,        /* 복용 전 관찰 */
  windowAfterMin: 240,        /* 복용 후 관찰 */
  timeGroupToleranceMin: 45,  /* 같은 복용으로 묶는 시각 허용범위 */
  riseStartDelta: 10,         /* "상승이 시작됐다"고 볼 최소 변화 (시각 탐지용) */
  meaningfulRiseOutput: 20,   /* "약이 반응했다"고 볼 최소 상승폭 (ON failure 구분용) */
  onFailureObserveMin: 120,   /* 이 시간 안에 상승이 없으면 ON failure 후보 */
  delayedAbsoluteMin: 30,     /* 개인 중앙값보다 이만큼 늦으면 delayed 후보 */
  delayedRatio: 1.5,          /* 또는 개인 중앙값의 이 배수 이상 */
  minEpisodesForBaseline: 3,  /* 개인 기준을 세우는 데 필요한 최소 사례 수 */
  maxInterpolateGapMin: 60,   /* 대표곡선 보간 허용 간격 */
  slowBaselineMin: 60,        /* 개인 중앙값 자체가 이보다 느리면 그룹 차원에서 따로 알림 */
};

function median(arr){
  const a=arr.filter(v=>v!=null&&!Number.isNaN(v)).slice().sort((x,y)=>x-y);
  if(!a.length) return null;
  const m=Math.floor(a.length/2);
  return a.length%2? a[m] : (a[m-1]+a[m])/2;
}
CLIN.median = median;
function hhmmToMin(s){ const [h,m]=String(s).split(":").map(Number); return h*60+m; }
CLIN.hhmmToMin = hhmmToMin;
function minToHhmm(t){ const v=((Math.round(t)%1440)+1440)%1440; return `${String(Math.floor(v/60)).padStart(2,"0")}:${String(v%60).padStart(2,"0")}`; }
CLIN.minToHhmm = minToHhmm;

/* ---- 0) 달력 기준 분석기간 ----
   검토 반영: "기록이 있는 최근 7개 날짜"가 아니라 "오늘부터 거슬러 7일(달력)"이어야 한다. */
CLIN.calendarPeriod = function(allDayKeys, periodDays, endDate){
  const end=endDate? new Date(endDate) : new Date();
  end.setHours(23,59,59,999);
  const start=new Date(end);
  start.setDate(start.getDate()-periodDays+1);
  start.setHours(0,0,0,0);
  const pad=n=>String(n).padStart(2,"0");
  const fmt=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const startKey=fmt(start), endKey=fmt(end);
  const keys=(allDayKeys||[]).filter(k=>k>=startKey && k<=endKey).sort();
  return {startKey, endKey, keys, calendarDays:periodDays, recordedDays:keys.length};
};

/* ---- 1) 복용 그룹화 ----
   doses: [{dayKey, name, dose, timeMin, ts}]
   같은 약 + 같은 용량 + 비슷한 시각(±tolerance)을 하나의 그룹으로 묶는다. */
CLIN.groupDoses = function(doses, opts){
  const o=Object.assign({}, CLIN.DEFAULTS, opts||{});
  const buckets=[];
  (doses||[]).slice().sort((a,b)=>a.timeMin-b.timeMin).forEach(d=>{
    const key=`${d.name}|${d.dose==null?"?":d.dose}`;
    let b=buckets.find(x=>x.key===key && Math.abs(median(x.items.map(i=>i.timeMin))-d.timeMin)<=o.timeGroupToleranceMin);
    if(!b){ b={key, name:d.name, dose:d.dose, items:[]}; buckets.push(b); }
    b.items.push(d);
  });
  return buckets.map(b=>{
    const times=b.items.map(i=>i.timeMin);
    const med=median(times);
    return {
      id:`${b.name}|${b.dose==null?"?":b.dose}|${Math.round(med)}`,
      name:b.name, dose:b.dose,
      medianTimeMin:med, timeLabel:minToHhmm(med),
      windowLabel:`${minToHhmm(Math.min(...times))}~${minToHhmm(Math.max(...times))}`,
      occurrences:b.items.length,
      items:b.items.slice().sort((x,y)=>x.ts-y.ts),
    };
  }).sort((a,b)=>a.medianTimeMin-b.medianTimeMin);
};

/* ---- 2) 복용 1회(에피소드) 분석 ----
   dose: {dayKey,name,dose,timeMin,ts}
   outputs: 그 날의 [{timeMin, val, ts}] (시간순)
   nextDoseTimeMin: 다음 복용 시각(있으면)
   events: 그 날의 부가 이벤트 [{kind:"dysk"|"meal"|"protein"|"sleep"|"bowel", timeMin}] */
CLIN.analyzeEpisode = function(dose, outputs, opts, nextDoseTimeMin, events){
  const o=Object.assign({}, CLIN.DEFAULTS, opts||{});
  const t=dose.timeMin;
  /* 검토 반영: 개별 복용 반응 판정은 "다음 도파민성 약 복용 직전"까지만 본다.
     다음 약 덕분에 올라간 출력을 앞 약의 효과로 잘못 읽지 않기 위함.
     다음 약과의 중첩은 overlapWindow로 따로 계산한다. */
  const endT = (nextDoseTimeMin!=null)
    ? Math.min(t+o.windowAfterMin, nextDoseTimeMin)
    : t+o.windowAfterMin;
  const pre=(outputs||[]).filter(p=>p.timeMin<=t && p.timeMin>=t-o.windowBeforeMin);
  const post=(outputs||[]).filter(p=>p.timeMin>t && p.timeMin<=endT);
  const preDose = pre.length? pre[pre.length-1].val : null;
  const res={
    dayKey:dose.dayKey, name:dose.name, dose:dose.dose, doseTimeMin:t,
    windowEndMin:endT, nextDoseTimeMin:(nextDoseTimeMin==null?null:nextDoseTimeMin),
    observedUntilMin: post.length? (post[post.length-1].timeMin - t) : null, /* 복용 후 실제 관찰시간 */
    truncatedByNextDose: (nextDoseTimeMin!=null && nextDoseTimeMin < t+o.windowAfterMin),
    preDoseOutput:preDose, postCount:post.length,
    riseStartMin:null, t50Min:null, t80Min:null, onLatencyMin:null,
    peakOutput:null, peakAtMin:null, riseAmount:null,
    dwellAboveOnMin:0, fellBelow50Min:null,
    dyskinesiaDuring:false, mealNearby:false, proteinNearby:false,
    classification:"insufficient_data", reasons:[],
  };
  if(preDose==null){ res.reasons.push("복용 전 출력 기록 없음"); }
  if(post.length<2){ res.reasons.push("복용 후 출력 기록 2개 미만"); }
  if(preDose==null || post.length<2) return res;

  let prev=preDose, prevT=t;
  post.forEach(p=>{
    if(res.peakOutput==null || p.val>res.peakOutput){ res.peakOutput=p.val; res.peakAtMin=p.timeMin-t; }
    if(res.riseStartMin==null && (p.val-preDose)>=o.riseStartDelta) res.riseStartMin=prevT===t? (p.timeMin-t) : (prevT-t);
    if(res.t50Min==null && p.val>=50) res.t50Min=p.timeMin-t;
    if(res.t80Min==null && p.val>=o.effectiveOnOutput) res.t80Min=p.timeMin-t;
    if(p.val>=o.effectiveOnOutput && prev>=o.effectiveOnOutput) res.dwellAboveOnMin += (p.timeMin-prevT);
    if(res.t80Min!=null && res.fellBelow50Min==null && p.val<50 && p.timeMin-t>res.t80Min) res.fellBelow50Min=p.timeMin-t;
    prev=p.val; prevT=p.timeMin;
  });
  res.onLatencyMin=res.t80Min;
  res.riseAmount=(res.peakOutput!=null)? (res.peakOutput-preDose) : null;

  (events||[]).forEach(e=>{
    if(e.timeMin>=t && e.timeMin<=endT && e.kind==="dysk") res.dyskinesiaDuring=true;
    if(Math.abs(e.timeMin-t)<=60 && e.kind==="meal") res.mealNearby=true;
    if(Math.abs(e.timeMin-t)<=60 && e.kind==="protein") res.proteinNearby=true;
  });
  return res;
};

/* ---- 3) 개인 기준 ---- */
CLIN.personalBaseline = function(episodes, opts){
  const o=Object.assign({}, CLIN.DEFAULTS, opts||{});
  const reached=episodes.filter(e=>e.onLatencyMin!=null);
  const lat=reached.map(e=>e.onLatencyMin);
  const peaks=episodes.filter(e=>e.peakOutput!=null).map(e=>e.peakOutput);
  const medLat=median(lat);
  return {
    medianOnLatencyMin:medLat,
    meanOnLatencyMin: lat.length? Math.round(lat.reduce((s,v)=>s+v,0)/lat.length) : null,
    normalRange: medLat!=null? [Math.max(0,Math.round(medLat*0.75)), Math.round(medLat*1.35)] : null,
    medianPeakOutput:median(peaks),
    reachedCount:reached.length,
    established: reached.length>=o.minEpisodesForBaseline,
  };
};

/* ---- 4) 에피소드 분류 (확정 진단 아님 — 후보) ---- */
CLIN.classifyEpisode = function(ep, baseline, opts){
  const o=Object.assign({}, CLIN.DEFAULTS, opts||{});
  if(ep.preDoseOutput==null || ep.postCount<2) return Object.assign({}, ep, {classification:"insufficient_data"});
  const out=Object.assign({}, ep, {reasons:ep.reasons.slice()});
  const reachedOn = ep.t80Min!=null;
  const rose = (ep.riseAmount!=null && ep.riseAmount>=o.meaningfulRiseOutput);

  if(!reachedOn && !rose){
    /* 검토 반영: 충분히 관찰하지 않았으면 ON failure로 단정하지 않는다 */
    const seen=ep.observedUntilMin;
    if(seen==null || seen<o.onFailureObserveMin){
      out.classification="insufficient_data";
      out.reasons.push(`복용 후 관찰시간 ${seen==null?0:Math.round(seen)}분 — ON failure 평가에 필요한 ${o.onFailureObserveMin}분 미만${ep.truncatedByNextDose?" (다음 복용 전에 창이 끝남)":""}`);
      return out;
    }
    out.classification="on_failure";
    out.reasons.push(`복용 후 상승폭 ${ep.riseAmount==null?"—":ep.riseAmount}점 (기준 ${o.meaningfulRiseOutput}점 미만), 관찰 ${Math.round(seen)}분`);
    return out;
  }
  if(!reachedOn && rose){
    out.classification="incomplete_on";
    out.reasons.push(`최고 출력 ${ep.peakOutput} — 유효 ON 기준 ${o.effectiveOnOutput} 미도달`);
    return out;
  }
  /* 검토 반영: 개인 기준이 확립되지 않았으면(도달 사례 3회 미만) delayed 판정을 보류한다 */
  if(!baseline || !baseline.established){
    out.classification="adequate";
    out.deferredDelayedJudgement=true;
    out.reasons.push(`개인 평소 ON 도달시간을 설정할 사례가 부족하여 Delayed ON 여부는 판정 보류했습니다`);
    return out;
  }
  const med=baseline.medianOnLatencyMin;
  if(med!=null && (ep.onLatencyMin >= med + o.delayedAbsoluteMin || ep.onLatencyMin >= med*o.delayedRatio)){
    out.classification="delayed_on";
    out.reasons.push(`ON 도달 ${ep.onLatencyMin}분 — 평소 중앙값 ${med}분보다 ${Math.round(ep.onLatencyMin-med)}분 늦음`);
    return out;
  }
  out.classification="adequate";
  return out;
};

/* ---- 5) 기간 분석 종합 ---- */
CLIN.LABELS = {
  delayed_on:"Delayed ON 후보", incomplete_on:"Incomplete ON 후보",
  on_failure:"ON failure 후보", adequate:"충분한 ON", insufficient_data:"판정 불가",
};
CLIN.periodSummary = function(classified, baseline){
  const total=classified.length;
  const judged=classified.filter(e=>e.classification!=="insufficient_data");
  const count=k=>classified.filter(e=>e.classification===k).length;
  const counts={delayed_on:count("delayed_on"), incomplete_on:count("incomplete_on"),
                on_failure:count("on_failure"), adequate:count("adequate"), insufficient_data:count("insufficient_data")};
  const ratios={};
  Object.keys(counts).forEach(k=>{ ratios[k]= judged.length? Math.round(counts[k]/judged.length*100) : 0; });
  const verdictFor=(k)=>{
    const n=counts[k], r=ratios[k];
    if(!judged.length) return "판정 불가";
    if(n===0) return "관찰되지 않음";
    if(n===1) return "단발성 가능성";
    if(r>=50) return "뚜렷한 반복 패턴";
    if(r>=30) return "반복 패턴 후보";
    return "반복 가능성";
  };
  /* 중요한 한계 보정: 평소가 늘 느리면 중앙값도 느려져 개별 사례가 delayed로 잡히지 않는다.
     이 경우 사례별 분류 대신 "이 복용의 평소 도달 자체가 느림"을 그룹 차원에서 알린다. */
  const o=CLIN.DEFAULTS;
  const medLat=baseline && baseline.medianOnLatencyMin;
  const slowBaseline = (medLat!=null && medLat>=o.slowBaselineMin);
  const slowBaselineNote = slowBaseline
    ? `이 복용은 평소 유효 ON 도달 중앙값이 ${medLat}분으로, 개별 날짜를 평소와 비교하는 방식으로는 delayed ON이 드러나지 않을 수 있습니다. 평소 도달 자체가 느린 상태인지 함께 살펴보세요.`
    : null;

  const deferred=classified.filter(e=>e.deferredDelayedJudgement).length;
  return {
    totalEpisodes:total, judgedEpisodes:judged.length, counts, ratios,
    slowBaseline, slowBaselineNote,
    deferredDelayedCount:deferred,
    deferredDelayedNote: deferred? `유효 ON 도달 사례가 ${baseline&&baseline.reachedCount||0}회로 적어 Delayed ON 판정은 보류했습니다.` : null,
    verdicts:{delayed_on:verdictFor("delayed_on"), incomplete_on:verdictFor("incomplete_on"), on_failure:verdictFor("on_failure")},
    baseline,
    reliable: judged.length>=3,
    reliabilityNote: judged.length>=3? null : `분석 가능한 사례가 ${judged.length}회뿐입니다. 판단의 신뢰도가 낮습니다.`,
  };
};

/* ---- 6) 동반 변수 비교 (식사·단백질) ---- */
CLIN.contextComparison = function(classified, problemKind){
  const prob=classified.filter(e=>e.classification===problemKind);
  const ok=classified.filter(e=>e.classification==="adequate");
  if(!prob.length || !ok.length) return null;
  const rate=(arr,f)=>arr.length? Math.round(arr.filter(f).length/arr.length*100) : 0;
  const out=[];
  const pm=rate(prob,e=>e.mealNearby), om=rate(ok,e=>e.mealNearby);
  if(prob.some(e=>e.mealNearby)||ok.some(e=>e.mealNearby))
    out.push({label:"식사 전후 복용", problemRate:pm, adequateRate:om,
      note:`${CLIN.LABELS[problemKind]} ${prob.length}회 중 ${prob.filter(e=>e.mealNearby).length}회, 충분한 ON ${ok.length}회 중 ${ok.filter(e=>e.mealNearby).length}회`});
  const pp=rate(prob,e=>e.proteinNearby), op=rate(ok,e=>e.proteinNearby);
  if(prob.some(e=>e.proteinNearby)||ok.some(e=>e.proteinNearby))
    out.push({label:"단백질 섭취 인접", problemRate:pp, adequateRate:op,
      note:`${CLIN.LABELS[problemKind]} ${prob.length}회 중 ${prob.filter(e=>e.proteinNearby).length}회, 충분한 ON ${ok.length}회 중 ${ok.filter(e=>e.proteinNearby).length}회`});
  if(!out.length) return null;
  return {items:out, caution:"사례 수가 적어 원인 관계를 판단하기에는 부족합니다. 레보도파 반응에는 위장관 기능과 흡수도 관여할 수 있습니다."};
};

/* ---- 7) 대표 곡선 (중앙값 기반) ----
   각 에피소드의 복용 시각을 0분으로 정렬해 상대 시점별 중앙값을 만든다.
   너무 긴 공백은 보간하지 않는다. */
CLIN.representativeCurve = function(episodesWithOutputs, opts){
  const o=Object.assign({}, CLIN.DEFAULTS, opts||{});
  const marks=[-60,-30,0,30,60,90,120,150,180,240];
  const pts=[];
  marks.forEach(rel=>{
    const vals=[];
    (episodesWithOutputs||[]).forEach(ep=>{
      const series=ep.relOutputs||[];
      /* 해당 상대시각 ±15분 내 기록만 사용, 없으면 인접 두 점 사이 간격이 짧을 때만 보간 */
      const near=series.filter(p=>Math.abs(p.rel-rel)<=15);
      if(near.length){ vals.push(near.sort((a,b)=>Math.abs(a.rel-rel)-Math.abs(b.rel-rel))[0].val); return; }
      const before=series.filter(p=>p.rel<rel).sort((a,b)=>b.rel-a.rel)[0];
      const after=series.filter(p=>p.rel>rel).sort((a,b)=>a.rel-b.rel)[0];
      if(before&&after&&(after.rel-before.rel)<=o.maxInterpolateGapMin){
        const f=(rel-before.rel)/(after.rel-before.rel);
        vals.push(before.val+(after.val-before.val)*f);
      }
    });
    const m=median(vals);
    if(m!=null) pts.push({rel, val:Math.round(m), n:vals.length});
  });
  return pts;
};

/* ---- 8) 목적(임상 문제) 정의 ---- */
CLIN.GOALS = [
  {id:"delayed_on",   label:"약효 시작이 늦음 — Delayed ON",        primaryMetric:"onLatencyMin"},
  {id:"incomplete_on",label:"약효가 충분히 올라오지 않음 — Incomplete ON", primaryMetric:"peakOutput"},
  {id:"on_failure",   label:"약을 먹어도 ON이 오지 않음 — ON failure",   primaryMetric:"riseAmount"},
  {id:"wearing_off",  label:"다음 복용 전에 출력이 떨어짐 — Wearing-off", primaryMetric:"fellBelow50Min"},
  {id:"low_gap",      label:"중간 시간대의 출력 공백",                  primaryMetric:"gapMin"},
  {id:"peak_dysk",    label:"최고점에서 이상운동증 발생",               primaryMetric:"peakOutput"},
];
CLIN.goalById = id => CLIN.GOALS.find(g=>g.id===id) || null;

if(typeof module!=="undefined"&&module.exports) module.exports=CLIN;
root.SIMCLIN=CLIN;
})(typeof window!=="undefined"?window:globalThis);
