/* ============================================================
   analysis-coverage.js — 치료구간 설계도 Phase 3: 과부족 분석 엔진
   책임: Phase 2에서 추정한 치료 구간(하한·상한)을 기준으로, 하루 곡선이
   그 구간 안에 머문 시간과 구간 밖(낮음·높음)에서 보낸 시간·크기를 계산한다.

   설계 원칙 (치료구간_과다과소_설계도 §3):
   - 목표는 "부족분을 채우는 것"이 아니라 "구간 내 체류시간을 늘리는 것"이다.
     이 파일은 그 판단에 필요한 사실(시간·크기)만 계산하고, 무엇을 하라고 말하지 않는다.
   - 상한이 없어도(이상운동증 기록이 아직 없어도) 하한만으로 "낮은 구간" 분석은 가능하다.
     이때 "높은 구간"은 계산하지 않는다 — 임의로 상한을 추정하지 않는다는 Phase 2 원칙을 잇는다.
   - 하한을 추정할 수 없으면(표본 부족 등) 이 파일은 아무 계산도 하지 않는다.
   - 결론·추천·처방 문구를 만들지 않는다. 숫자만 낸다.
   - DOM·localStorage에 의존하지 않는다 (Node 단독 테스트 가능).
   ============================================================ */
(function(root){
"use strict";
const COV = {};

/* 연속 구간을 하나의 세그먼트로 묶고, 그 구간의 평균/최고 차이와 면적(시간×크기)을 계산한다. */
function finalizeSegment(seg){
  const n=seg._diffs.length;
  seg.meanDeltaLed = n? seg._diffs.reduce((a,b)=>a+b,0)/n : 0;
  /* 면적(시간×크기) = 각 점의 (차이 × 그 점이 차지하는 실제 폭)의 합 — 고정폭 가정 없음 */
  seg.areaLedMin = seg._diffs.reduce((sum,d,i)=>sum+d*seg._widths[i], 0);
  delete seg._diffs; delete seg._widths;
  return seg;
}

/* ---- 과부족 분석 ----
   rawPoints: [{t, led}] — 하루(또는 임의 구간)의 복합 약효 추정곡선 원단위(Phase 1).
   window: {lower, upper} — Phase 2에서 추정한 치료 구간. upper는 null일 수 있다(이상운동증 기록 없음).
   opts.step: 이웃한 점 사이 실제 시간간격을 알 수 없을 때 쓰는 기본값(분). 보통은 안 쓰인다.

   경계값 버그 수정(2026-08-05, 실기기 확인): 0~1440분을 10분 간격으로 만들면 145개 점이
   생기는데(0,10,...,1440 — 24:00과 다음날 00:00이 사실 같은 순간), 예전 코드는 점마다
   고정 10분씩 더해 총합이 145×10=1450분이 되어 하루(1440분)보다 10분 많이 셌다. 14일이면
   140분(≈2.3시간)이 부풀려져 실제 사용자 데이터에서 "구간 안+낮음+높음" 합이 14×24시간보다
   컸다. 지금은 고정폭 대신 "다음 점까지의 실제 시간차"를 폭으로 쓴다 — 마지막 점(24:00)은
   그 다음 순간이 이 배열 안에 없으므로 자연스럽게 폭 0(집계에 기여 안 함)이 되어 정확해진다. */
COV.analyze = function(rawPoints, window, opts){
  const o=Object.assign({step:10}, opts||{});
  const reasons=[];
  if(!rawPoints || !rawPoints.length){
    reasons.push("곡선 데이터가 없어 과부족을 계산할 수 없습니다");
    return {valid:false, reasons};
  }
  if(!window || window.lower==null){
    reasons.push("하한(OFF 역치)을 추정할 수 없어 과부족을 계산할 수 없습니다");
    return {valid:false, reasons};
  }
  const lower=window.lower;
  const hasUpper = window.upper!=null;
  const upper = hasUpper? window.upper : null;

  let inWindowMin=0, underMin=0, overMin=0;
  const underSegments=[], overSegments=[];
  let curUnder=null, curOver=null;

  for(let i=0;i<rawPoints.length;i++){
    const p=rawPoints[i];
    const next=rawPoints[i+1];
    const width = next? Math.max(0, next.t-p.t) : 0; /* 마지막 점은 그 다음 순간이 없으므로 폭 0 */
    const led=p.led;
    const isUnder = led<lower;
    const isOver = hasUpper && led>upper;

    if(isUnder){
      underMin+=width;
      const deficit=lower-led;
      if(!curUnder) curUnder={startMin:p.t, endMin:p.t+width, maxDeficitLed:deficit, _diffs:[deficit], _widths:[width]};
      else { curUnder.endMin=p.t+width; curUnder.maxDeficitLed=Math.max(curUnder.maxDeficitLed,deficit); curUnder._diffs.push(deficit); curUnder._widths.push(width); }
    } else if(curUnder){ underSegments.push(finalizeSegment(curUnder)); curUnder=null; }

    if(isOver){
      overMin+=width;
      const excess=led-upper;
      if(!curOver) curOver={startMin:p.t, endMin:p.t+width, maxExcessLed:excess, _diffs:[excess], _widths:[width]};
      else { curOver.endMin=p.t+width; curOver.maxExcessLed=Math.max(curOver.maxExcessLed,excess); curOver._diffs.push(excess); curOver._widths.push(width); }
    } else if(curOver){ overSegments.push(finalizeSegment(curOver)); curOver=null; }

    if(!isUnder && !isOver) inWindowMin+=width;
  }
  if(curUnder) underSegments.push(finalizeSegment(curUnder));
  if(curOver) overSegments.push(finalizeSegment(curOver));

  const worst=(segs)=> segs.length? segs.reduce((a,b)=> b.areaLedMin>a.areaLedMin? b:a) : null;
  if(!hasUpper) reasons.push("상한(이상운동증 역치)을 추정할 수 없어 높은 구간은 계산하지 않았습니다 — 낮은 구간만 계산했습니다");

  return {
    valid:true, hasUpper, reasons,
    inWindowMin, underMin, overMin,
    underSegments, overSegments,
    worstUnder: worst(underSegments), worstOver: worst(overSegments),
  };
};

/* 여러 날의 결과를 하나로 합친다 (기간 전체 관점의 요약).
   dayResults: [{dayKey, ...COV.analyze 결과}] */
COV.aggregate = function(dayResults){
  const valid=(dayResults||[]).filter(d=>d && d.valid);
  if(!valid.length) return {valid:false, reasons:["과부족을 계산할 수 있는 날이 없습니다"]};
  let inWindowMin=0, underMin=0, overMin=0, worstUnder=null, worstOver=null, hasUpper=false;
  valid.forEach(d=>{
    inWindowMin+=d.inWindowMin; underMin+=d.underMin; overMin+=d.overMin;
    if(d.hasUpper) hasUpper=true;
    if(d.worstUnder && (!worstUnder || d.worstUnder.areaLedMin>worstUnder.areaLedMin))
      worstUnder=Object.assign({dayKey:d.dayKey}, d.worstUnder);
    if(d.worstOver && (!worstOver || d.worstOver.areaLedMin>worstOver.areaLedMin))
      worstOver=Object.assign({dayKey:d.dayKey}, d.worstOver);
  });
  return {valid:true, dayCount:valid.length, inWindowMin, underMin, overMin, hasUpper, worstUnder, worstOver, reasons:[]};
};

if(typeof module!=="undefined"&&module.exports) module.exports=COV;
root.SIMCOV = COV;
})(typeof window!=="undefined"?window:globalThis);
