/* ============================================================
   analysis-daily.js — 치료구간 설계도 Phase 6: 일일 잔차 성적표 엔진
   책임: 하루(dayKey)에 대해 예측곡선(SIMDRUG.compositeCurve)과 실측(출력 체크·사건)을
   비교해 잔차 4지표(도달 지연·피크 잔차·조기 소진·골 깊이)를 계산한다.

   설계 원칙 (치료구간_설계도 Phase 6):
   - 판단·권고 문구를 만들지 않는다. 숫자와 사실만 낸다.
   - 표본 부족·역치 부재 등으로 계산할 수 없는 지표는 추정을 강행하지 않고 null +
     reasons에 사유를 남긴다(다른 analysis-*.js 모듈과 동일 원칙).
   - 절대 단위가 다른 값과 비교하지 않는다 — 출력(%)과 LED(rawPoints)를 섞어 크기를
     비교하지 않는다(피크 잔차의 "높이 차"를 계산하지 않는 이유).
   - "실측 유효 ON 도달"은 analysis-clinical.js(SIMCLIN)의 판정 로직(analyzeEpisode)을
     재사용한다 — 이 파일이 독자적인 ON 판정 규칙을 새로 만들지 않는다.
   - DOM·localStorage에 의존하지 않는다 (Node 단독 테스트 가능). SIMDRUG·SIMCLIN이
     있어야 동작한다.
   ============================================================ */
(function(root){
"use strict";
const DAY = {};

function getSIMDRUG(){
  if(typeof module!=="undefined"&&module.exports && typeof require==="function"){
    try{ return require("./simulation-drugmodel.js"); }catch(e){}
  }
  return (typeof window!=="undefined"&&window.SIMDRUG) || (typeof SIMDRUG!=="undefined"?SIMDRUG:null);
}
function getSIMCLIN(){
  if(typeof module!=="undefined"&&module.exports && typeof require==="function"){
    try{ return require("./analysis-clinical.js"); }catch(e){}
  }
  return (typeof window!=="undefined"&&window.SIMCLIN) || (typeof SIMCLIN!=="undefined"?SIMCLIN:null);
}

DAY.DEFAULTS = {
  effectiveOnOutput: 80,   /* SIMCLIN.DEFAULTS.effectiveOnOutput과 같은 기본값 — 개인 판정 로직을 재사용하는 것이므로 이 값도 그대로 맞춘다 */
  troughWindowMin: 60,     /* 복용 직전 골 깊이를 찾는 창 */
  insufficientN: 3,        /* aggregate에서 표본 3일 미만이면 valid:false (다른 모듈과 동일 기준) */
};

function median(arr){
  const a=(arr||[]).filter(v=>v!=null&&!Number.isNaN(v)).slice().sort((x,y)=>x-y);
  if(!a.length) return null;
  const m=Math.floor(a.length/2);
  return a.length%2? a[m] : (a[m-1]+a[m])/2;
}
DAY.median = median;
function hhmmToMin(s){ const [h,m]=String(s).split(":").map(Number); return h*60+m; }
function minToHhmm(t){ const v=((Math.round(t)%1440)+1440)%1440; return `${String(Math.floor(v/60)).padStart(2,"0")}:${String(v%60).padStart(2,"0")}`; }

/* ---- 하루 잔차 4지표 ----
   input:
     doses: [{name, dose, time:"HH:MM", dayOffset?}] — SIMDRUG.compositeCurve와 같은 형식(이월분 포함 가능)
     outputChecks: [{timeMin, val}] — 그 날 실측 출력(시각순 정렬 불필요, 내부에서 정렬함)
     events: [{timeMin, kind}] — kind:"dysk"|"meal"|"protein" 등, analysis-clinical.js와 같은 형식
     thresholds: {lower, upper} — SIMTHR가 추정한 치료 구간(원단위 LED, rawPoints와 같은 스케일).
       analysis-coverage.js(SIMCOV.analyze)와 같은 방식으로 "값"만 받는다(전체 bound 객체가 아님).
     tzWindow: {t0,t1,step} — compositeCurve 계산 범위(생략 시 하루 0~1440분, 10분 간격)
     effectiveOnOutput: 유효 ON 기준 출력(생략 시 DAY.DEFAULTS.effectiveOnOutput=80,
       SIMCLIN.DEFAULTS.effectiveOnOutput과 동일)
   반환: { valid, reasons:[], onsetDelayMin, peakResidual:{timeDeltaMin, overflow}, earlyFadeMin, troughs, samples } */
DAY.dailyResiduals = function(input){
  input = input||{};
  const reasons=[];
  const empty=()=>({valid:false, reasons, onsetDelayMin:null, peakResidual:{timeDeltaMin:null, overflow:false}, earlyFadeMin:null, troughs:[], samples:{}});

  const DM=getSIMDRUG();
  if(!DM){ reasons.push("SIMDRUG(약물 모델) 엔진을 찾을 수 없습니다"); return empty(); }
  const doseList=(input.doses||[]).filter(d=>d&&d.time);
  if(!doseList.length){ reasons.push("그 날 복용 기록이 없어 잔차를 계산할 수 없습니다"); return empty(); }

  const tw=Object.assign({t0:0, t1:1440, step:10}, input.tzWindow||{});
  const composite=DM.compositeCurve(doseList, tw.t0, tw.t1, tw.step);
  const rawPoints=composite.rawPoints||[];

  const checks=(input.outputChecks||[]).filter(c=>c&&c.timeMin!=null&&c.val!=null).slice().sort((a,b)=>a.timeMin-b.timeMin);
  const events=(input.events||[]).filter(e=>e&&e.timeMin!=null);
  const dyskEvents=events.filter(e=>e.kind==="dysk");

  const lower = (input.thresholds && input.thresholds.lower!=null) ? input.thresholds.lower : null;
  const effOn = input.effectiveOnOutput!=null ? input.effectiveOnOutput : DAY.DEFAULTS.effectiveOnOutput;

  /* ---- ①도달 지연: (실측 유효 ON 도달 시각) − (예측 ON 시각) ----
     실측 유효 ON 도달은 그 날 첫 direct_curve(레보도파류) 복용을 기준으로 SIMCLIN.analyzeEpisode를
     재사용해 판정한다(다음 복용 전까지만 관찰 — 다음 약 효과가 앞 약 효과로 잘못 읽히지 않도록,
     analysis-clinical.js §2의 규칙을 그대로 따른다). */
  const CLIN=getSIMCLIN();
  const todays=doseList.filter(d=>!(d.dayOffset<0));
  const primaryDose = todays
    .filter(d=>{ const m=DM.classify(d.name); return m && m.role==="direct_curve"; })
    .sort((a,b)=>hhmmToMin(a.time)-hhmmToMin(b.time))[0] || null;

  let onsetDelayMin=null, predictedOnsetTimeMin=null, actualOnsetTimeMin=null, episode=null;
  if(!CLIN){
    reasons.push("SIMCLIN(기록 분석) 엔진을 찾을 수 없어 도달 지연·조기 소진을 계산할 수 없습니다");
  } else if(!primaryDose){
    reasons.push("그 날 레보도파 계열(direct_curve) 복용이 없어 도달 지연을 계산할 수 없습니다");
  } else {
    const doseTimeMin=hhmmToMin(primaryDose.time);
    const nextDose = todays.filter(d=>hhmmToMin(d.time)>doseTimeMin).sort((a,b)=>hhmmToMin(a.time)-hhmmToMin(b.time))[0];
    const nextDoseTimeMin = nextDose? hhmmToMin(nextDose.time) : null;
    episode = CLIN.analyzeEpisode(
      {dayKey:null, name:primaryDose.name, dose:primaryDose.dose, timeMin:doseTimeMin},
      checks, {effectiveOnOutput:effOn}, nextDoseTimeMin, events
    );
    if(episode.onLatencyMin!=null) actualOnsetTimeMin = doseTimeMin + episode.onLatencyMin;
    else reasons.push(...episode.reasons);

    if(lower==null){ reasons.push("하한(OFF 역치)이 없어 예측 ON 시각을 계산할 수 없습니다"); }
    else {
      const hit=rawPoints.find(p=>p.t>=doseTimeMin && p.led>=lower);
      predictedOnsetTimeMin = hit? hit.t : null;
      if(!hit) reasons.push("예측 곡선이 관찰기간 내에 하한 역치를 넘지 않았습니다");
    }
    if(predictedOnsetTimeMin!=null && actualOnsetTimeMin!=null) onsetDelayMin = actualOnsetTimeMin - predictedOnsetTimeMin;
  }

  /* ---- ②피크 잔차 & ③조기 소진의 관찰 창 ----
     복용이 겹치는 날(다음 약을 먹기 전까지)에는 다음 복용의 효과가 앞 복용 효과로
     섞여 들어간다 — analysis-clinical.js §2가 이미 그 창을 계산해 두었으므로
     (episode.windowEndMin) 그대로 재사용한다. 첫 direct_curve 복용이 없으면(=이
     지표들의 기준으로 삼을 복용이 없으면) 관찰 창을 하루 전체로 둔다. */
  const winStart = primaryDose? hhmmToMin(primaryDose.time) : tw.t0;
  const winEnd = (primaryDose && episode)? episode.windowEndMin : tw.t1;

  /* ---- ②피크 잔차: 실측 피크 시각 − 예측 피크 시각. 높이 차는 계산하지 않는다
     (출력%과 LED는 단위가 달라 절대 비교 금지 원칙 위반). overflow는 그 날 이상운동
     사건 존재 여부만 본다(곡선값으로 추정하지 않는다 — 사건 기반 사실, 관찰 창과 무관하게
     하루 전체를 본다). ---- */
  let predictedPeakTimeMin=null, predictedPeakLed=null;
  rawPoints.filter(p=>p.t>=winStart && p.t<=winEnd).forEach(p=>{ if(predictedPeakLed==null || p.led>predictedPeakLed){ predictedPeakLed=p.led; predictedPeakTimeMin=p.t; } });
  let actualPeakTimeMin=null, actualPeakVal=null;
  checks.filter(c=>c.timeMin>=winStart && c.timeMin<=winEnd).forEach(c=>{ if(actualPeakVal==null || c.val>actualPeakVal){ actualPeakVal=c.val; actualPeakTimeMin=c.timeMin; } });
  let peakTimeDeltaMin=null;
  if(predictedPeakTimeMin!=null && actualPeakTimeMin!=null) peakTimeDeltaMin = actualPeakTimeMin - predictedPeakTimeMin;
  else reasons.push("실측 출력 기록이 없어 피크 시각을 비교할 수 없습니다");
  const overflow = dyskEvents.length>0;

  /* ---- ③조기 소진: (예측 하강 시각) − (실측 하강 시각). 양수 = 예측보다 일찍 꺼짐.
     예측 하강 시각 = 관찰 창 안에서 예측곡선의 최고점 이후 하한 아래로 처음 내려가는 시각.
     실측 하강 시각 = 유효 ON 도달 이후 출력이 baseline 유효선(effectiveOnOutput) 아래로
     처음 내려간 시각(같은 관찰 창 안). 둘 다 역치·도달 자체가 있어야 계산된다. ---- */
  let predictedFadeTimeMin=null, actualFadeTimeMin=null, earlyFadeMin=null;
  if(lower!=null && predictedPeakTimeMin!=null){
    const hit=rawPoints.find(p=>p.t>predictedPeakTimeMin && p.t<=winEnd && p.led<lower);
    predictedFadeTimeMin = hit? hit.t : null;
    if(!hit) reasons.push("예측 곡선이 관찰기간 안에 하한 아래로 내려가지 않았습니다");
  }
  if(actualOnsetTimeMin!=null){
    const hit=checks.find(c=>c.timeMin>actualOnsetTimeMin && c.timeMin<=winEnd && c.val<effOn);
    actualFadeTimeMin = hit? hit.timeMin : null;
    if(!hit) reasons.push("실측 출력이 유효 ON 도달 이후 관찰기간 안에 기준 아래로 내려가지 않았습니다");
  } else if(CLIN && primaryDose){
    reasons.push("유효 ON 도달 자체가 없어 조기 소진을 계산할 수 없습니다");
  }
  if(predictedFadeTimeMin!=null && actualFadeTimeMin!=null) earlyFadeMin = predictedFadeTimeMin - actualFadeTimeMin;

  /* ---- ④골 깊이: 각 복용 직전 60분 창의 최저 실측 출력. 실측이 그 창에 없으면 그 골은 제외.
     같은 시각에 여러 약을 함께 복용하면(약 세트) 하나의 복용 사건으로 묶는다. 이월분
     (dayOffset<0)은 "오늘의 복용"이 아니므로 골 계산에서 제외한다. ---- */
  const troughWin=input.troughWindowMin!=null? input.troughWindowMin : DAY.DEFAULTS.troughWindowMin;
  const doseTimes=[...new Set(todays.map(d=>hhmmToMin(d.time)))].sort((a,b)=>a-b);
  const troughs=doseTimes.map(dt=>{
    const win=checks.filter(c=>c.timeMin>=dt-troughWin && c.timeMin<=dt);
    if(!win.length) return null;
    const min=win.reduce((a,b)=>b.val<a.val?b:a);
    return {beforeDoseTime:minToHhmm(dt), output:min.val};
  }).filter(Boolean);

  return {
    valid:true, reasons,
    onsetDelayMin,
    peakResidual:{timeDeltaMin:peakTimeDeltaMin, overflow},
    earlyFadeMin,
    troughs,
    samples:{
      effectiveOnOutput:effOn, lowerThreshold:lower,
      primaryDose: primaryDose? {name:primaryDose.name, time:primaryDose.time} : null,
      onLatencyMin: episode? episode.onLatencyMin : null,
      predictedOnsetTimeMin, actualOnsetTimeMin,
      predictedPeakTimeMin, actualPeakTimeMin, predictedPeakLed, actualPeakVal,
      predictedFadeTimeMin, actualFadeTimeMin,
      doseCount:doseList.length, outputCheckCount:checks.length, dyskEventCount:dyskEvents.length,
    },
  };
};

/* ---- 누적: 최근 N일 결과 배열 → 지표별 중앙값·표본수 ----
   각 지표는 그 지표를 계산할 수 있었던 날짜만 모아 중앙값을 낸다(다른 날 결측과 무관).
   전체 표본(유효한 날짜 수)이 3일 미만이면 valid:false — 개별 지표가 일부 있어도
   경향으로 보기엔 이르다는 다른 모듈과 같은 기준(insufficientN). */
DAY.aggregate = function(dailyList){
  const valid=(dailyList||[]).filter(d=>d&&d.valid);
  const n=valid.length;
  if(n<DAY.DEFAULTS.insufficientN){
    return {valid:false, n, reasons:[`표본이 ${n}일로 부족합니다 (최소 ${DAY.DEFAULTS.insufficientN}일 필요)`]};
  }
  const metric=(pick)=>{ const arr=valid.map(pick).filter(v=>v!=null); return {median:median(arr), n:arr.length}; };
  const allTroughs=valid.reduce((acc,d)=>acc.concat(d.troughs||[]), []);
  return {
    valid:true, n, reasons:[],
    onsetDelayMin: metric(d=>d.onsetDelayMin),
    peakTimeDeltaMin: metric(d=>d.peakResidual&&d.peakResidual.timeDeltaMin),
    overflowDays: valid.filter(d=>d.peakResidual&&d.peakResidual.overflow).length,
    earlyFadeMin: metric(d=>d.earlyFadeMin),
    troughOutput: {median:median(allTroughs.map(t=>t.output)), n:allTroughs.length},
  };
};

if(typeof module!=="undefined"&&module.exports) module.exports=DAY;
root.SIMDAY = DAY;
})(typeof window!=="undefined"?window:globalThis);
