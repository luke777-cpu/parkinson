/* ============================================================
   analysis-threshold.js — 치료구간 설계도 Phase 2: 역치 추정 엔진
   책임: OFF로 떨어진 시각·이상운동증이 시작된 시각의 "그 순간 약효 추정곡선 값"을
   여러 날 모아 중앙값을 내어, 그 사람의 치료 구간(하한·상한)을 실측으로 구한다.

   설계 원칙 (치료구간_과다과소_설계도 §2, §6):
   - 여기서 만드는 역치는 외부 계산기의 "실제 혈장 mg"가 아니라, 같은 곡선 엔진의
     rawPoints(포화 전 원단위, simulation-drugmodel.js Phase 1)와 같은 스케일 안에서
     자기 참조로 비교되는 값이다. 절대 단위가 다른 것과 비교하지 않는다.
   - 역치는 절대 기준이 아니라 "회원님의 기록 N회 기준" 추정값이다. 표본이 부족하면
     숫자를 내지 않는다(analysis-clinical.js의 reproducibility와 같은 원칙).
   - 상한(이상운동증 역치) < 하한(OFF 역치)이면 치료 구간이 성립하지 않는다 — 이 경우
     valid:false로 명시하고 이후 계산(과부족 분석)으로 넘어가지 않도록 한다.
   - 이 파일은 결론·추천·처방 문구를 만들지 않는다. 숫자와 신뢰도만 낸다.
   - DOM·localStorage에 의존하지 않는다 (Node 단독 테스트 가능).
   ============================================================ */
(function(root){
"use strict";
const THR = {};

THR.DEFAULTS = {
  insufficientN: 3,     /* 표본 3회 미만이면 추정하지 않는다 (analysis-clinical.js와 동일 기준) */
  poorRatio: 0.60,
  moderateRatio: 0.30,
  nearestToleranceMin: 30, /* 이 시간 이내의 곡선 점만 "그 순간 값"으로 인정 */
};

function median(arr){
  const a=(arr||[]).filter(v=>v!=null&&!Number.isNaN(v)).slice().sort((x,y)=>x-y);
  if(!a.length) return null;
  const m=Math.floor(a.length/2);
  return a.length%2? a[m] : (a[m-1]+a[m])/2;
}
THR.median = median;
function iqr(values){
  const a=(values||[]).filter(v=>v!=null&&!Number.isNaN(v)).slice().sort((x,y)=>x-y);
  if(a.length<2) return null;
  const q=(arr,p)=>{ const pos=(arr.length-1)*p, base=Math.floor(pos), rest=pos-base;
    return arr[base+1]!==undefined? arr[base]+rest*(arr[base+1]-arr[base]) : arr[base]; };
  return q(a,0.75)-q(a,0.25);
}
THR.iqr = iqr;

/* 곡선(rawPoints)에서 특정 시각에 가장 가까운 값을 읽는다. 너무 멀면(허용오차 초과) null. */
THR.valueAtTime = function(rawPoints, timeMin, toleranceMin){
  const tol = toleranceMin==null? THR.DEFAULTS.nearestToleranceMin : toleranceMin;
  if(!rawPoints || !rawPoints.length) return null;
  let best=rawPoints[0], bestDist=Math.abs(rawPoints[0].t-timeMin);
  for(const p of rawPoints){ const d=Math.abs(p.t-timeMin); if(d<bestDist){ best=p; bestDist=d; } }
  return bestDist<=tol? best.led : null;
};

function confidenceLevel(n, ratio, opts){
  const o=Object.assign({}, THR.DEFAULTS, opts||{});
  if(n<o.insufficientN) return "insufficient";
  if(ratio==null) return "insufficient";
  if(ratio>o.poorRatio) return "low";
  if(ratio>o.moderateRatio) return "moderate";
  return "good";
}
THR.confidenceLevel = confidenceLevel;

/* ---- 하한(OFF 역치) 추정 ----
   samples: [{dayKey, offTimeMin, rawPoints}] — offTimeMin은 그 날 출력이 OFF로 떨어진 시각(분),
   rawPoints는 그 날의 복합 약효 추정곡선 원단위({t,led}[]). 둘 다 호출부(UI)가 준비해서 넘긴다
   — 이 엔진은 "무엇이 OFF인지" 판단하지 않고, 주어진 OFF 시각에서 곡선값만 읽어 통계를 낸다. */
THR.estimateLowerBound = function(samples, opts){
  const o=Object.assign({}, THR.DEFAULTS, opts||{});
  const reasons=[];
  const values=[]; const detail=[];
  (samples||[]).forEach(s=>{
    if(s.offTimeMin==null || !s.rawPoints){ return; }
    const v=THR.valueAtTime(s.rawPoints, s.offTimeMin, o.nearestToleranceMin);
    if(v==null){ return; }
    values.push(v); detail.push({dayKey:s.dayKey, offTimeMin:s.offTimeMin, led:Math.round(v*100)/100});
  });
  const n=values.length;
  if(n<o.insufficientN){
    reasons.push(`OFF 시점의 곡선값을 읽을 수 있는 사례가 ${n}회로 부족합니다 (최소 ${o.insufficientN}회 필요)`);
    return {value:null, n, range:null, iqr:null, confidence:"insufficient", reasons, samples:detail};
  }
  const med=median(values);
  const iqrVal=iqr(values);
  const ratio=(med&&med>0)? iqrVal/med : null;
  const confidence=confidenceLevel(n, ratio, o);
  if(confidence==="low") reasons.push(`OFF 시점 곡선값의 편차가 큽니다 (사분위범위 ${Math.round(iqrVal*100)/100}, 중앙값의 ${Math.round(ratio*100)}%)`);
  else if(confidence==="moderate") reasons.push(`OFF 시점 곡선값의 편차가 다소 있습니다 (중앙값의 ${Math.round(ratio*100)}%)`);
  const sorted=values.slice().sort((a,b)=>a-b);
  return {value:med, n, range:[sorted[0], sorted[sorted.length-1]], iqr:iqrVal, confidence, reasons, samples:detail};
};

/* ---- 상한(이상운동증 역치) 추정 ----
   samples: [{dayKey, dyskOnsetTimeMin, rawPoints}] — 이상운동증이 시작된 시각.
   이상운동증 기록이 아예 없으면(samples가 비어있으면) 상한을 임의로 만들지 않고
   value:null, confidence:"insufficient"로 반환한다 — 하한만으로도 과소 분석은 가능해야 하므로
   상한 없음이 전체 계산을 막지 않도록 호출부가 이 반환값을 그렇게 다뤄야 한다. */
THR.estimateUpperBound = function(samples, opts){
  const o=Object.assign({}, THR.DEFAULTS, opts||{});
  const reasons=[];
  const values=[]; const detail=[];
  (samples||[]).forEach(s=>{
    if(s.dyskOnsetTimeMin==null || !s.rawPoints){ return; }
    const v=THR.valueAtTime(s.rawPoints, s.dyskOnsetTimeMin, o.nearestToleranceMin);
    if(v==null){ return; }
    values.push(v); detail.push({dayKey:s.dayKey, dyskOnsetTimeMin:s.dyskOnsetTimeMin, led:Math.round(v*100)/100});
  });
  const n=values.length;
  if(!samples || !samples.length){
    reasons.push("이상운동증 기록이 없습니다 — 상한은 추정하지 않습니다 (하한만으로 과소 분석은 가능합니다)");
    return {value:null, n:0, range:null, iqr:null, confidence:"insufficient", reasons, samples:[]};
  }
  if(n<o.insufficientN){
    reasons.push(`이상운동증 시점의 곡선값을 읽을 수 있는 사례가 ${n}회로 부족합니다 (최소 ${o.insufficientN}회 필요)`);
    return {value:null, n, range:null, iqr:null, confidence:"insufficient", reasons, samples:detail};
  }
  const med=median(values);
  const iqrVal=iqr(values);
  const ratio=(med&&med>0)? iqrVal/med : null;
  const confidence=confidenceLevel(n, ratio, o);
  if(confidence==="low") reasons.push(`이상운동증 시점 곡선값의 편차가 큽니다 (사분위범위 ${Math.round(iqrVal*100)/100}, 중앙값의 ${Math.round(ratio*100)}%)`);
  else if(confidence==="moderate") reasons.push(`이상운동증 시점 곡선값의 편차가 다소 있습니다 (중앙값의 ${Math.round(ratio*100)}%)`);
  const sorted=values.slice().sort((a,b)=>a-b);
  return {value:med, n, range:[sorted[0], sorted[sorted.length-1]], iqr:iqrVal, confidence, reasons, samples:detail};
};

/* ---- 치료 구간 ----
   하한·상한을 합쳐 구간을 확정한다. 상한이 하한보다 낮거나 같으면(=이상운동증이
   OFF보다도 낮은 곡선값에서 나타난다는, 물리적으로 이상한 결과) valid:false로
   명시하고 이후(과부족 분석) 단계로 넘어가지 못하게 한다. */
THR.therapeuticWindow = function(lower, upper){
  const reasons=[];
  if(!lower || lower.value==null){
    reasons.push("하한(OFF 역치)을 추정할 수 없어 치료 구간을 계산할 수 없습니다");
    return {lower, upper, width:null, valid:false, reasons};
  }
  if(!upper || upper.value==null){
    reasons.push("상한(이상운동증 역치)을 추정할 수 없습니다 — 하한만으로 과소(부족) 분석은 가능하지만, 과다(초과) 분석은 할 수 없습니다");
    return {lower, upper, width:null, valid:false, reasons};
  }
  if(upper.value<=lower.value){
    reasons.push(`상한(${Math.round(upper.value*100)/100})이 하한(${Math.round(lower.value*100)/100})보다 낮거나 같습니다 — 치료 구간이 성립하지 않습니다. 기록을 다시 확인해 주세요`);
    return {lower, upper, width:null, valid:false, reasons};
  }
  return {lower, upper, width:upper.value-lower.value, valid:true, reasons};
};

if(typeof module!=="undefined"&&module.exports) module.exports=THR;
root.SIMTHR = THR;
})(typeof window!=="undefined"?window:globalThis);
