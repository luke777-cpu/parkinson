/* ============================================================
   analysis-validation.js — 치료구간 설계도 Phase 5: 예측 vs 실제 검증 엔진
   책임: Phase 4에서 낸 예측(어떤 변경이 구간 내 체류시간을 얼마나 늘릴 것으로 보이는가)이,
   실제로 그 변경을 적용한 뒤의 기록과 얼마나 맞았는지 비교한다.

   설계 원칙 (치료구간_과다과소_설계도 §5):
   - 이건 앱이 스스로 검증하는 유일한 단계다 — 자기 예측이 맞았는지 실측으로 확인한다.
   - 예측과 실제가 안 맞아도 실패가 아니다. 그 차이 자체가 곡선 모델을 고치는 데 쓰인다.
   - 표본 하나로 결론 내지 않는다. 반복될수록 신뢰도가 오른다(N-of-1 반복측정).
   - "이 예측이 맞았다/틀렸다"를 단정하지 않고, 오차 크기와 방향만 사실로 낸다.
   - DOM·localStorage에 의존하지 않는다 (Node 단독 테스트 가능).
   ============================================================ */
(function(root){
"use strict";
const VAL = {};

/* 실제 하루의 복용 목록이 Phase 4가 제안한 후보안과 "그 정도면 같다"고 볼 수 있는지 확인한다.
   candidateDoses에 있는 항목이 전부(느슨하게) actualDoses 안에서 발견되면 일치로 본다 —
   실제 기록은 후보안이 건드리지 않은 다른 약을 더 갖고 있어도 된다(그건 변경과 무관하므로). */
/* 시각 허용오차를 30분이 아니라 15분으로 둔다. Phase 4의 "시각 이동" 후보가 정확히
   30분을 옮기므로, 허용오차가 30분이면 아무것도 안 바꾼 원래 기록조차 그 후보와
   "우연히 일치"로 잘못 판정될 수 있다(실사용 전 테스트에서 발견) — 기록 오차를
   흡수할 만큼은 넉넉하되, 가장 작은 의도적 변경(30분)보다는 확실히 좁게 잡는다. */
VAL.DEFAULTS = { timeToleranceMin:15, doseToleranceRatio:0.2 };
VAL.dosesMatchCandidate = function(actualDoses, candidateDoses, opts){
  const o=Object.assign({}, VAL.DEFAULTS, opts||{});
  const reasons=[];
  if(!candidateDoses || !candidateDoses.length) return {matches:false, reasons:["후보안에 복용 항목이 없습니다"]};
  if(!actualDoses || !actualDoses.length) return {matches:false, reasons:["그 날 실제 복약 기록이 없습니다"]};

  const timeMin=t=>{ const [h,m]=String(t).split(":").map(Number); return h*60+m; };
  let allMatched=true;
  candidateDoses.forEach(cd=>{
    const hit=actualDoses.find(ad=>{
      if(String(ad.name).trim()!==String(cd.name).trim()) return false;
      const dt=Math.abs(timeMin(ad.time)-timeMin(cd.time));
      if(dt>o.timeToleranceMin) return false;
      if(cd.dose==null || ad.dose==null) return cd.dose==null; /* 둘 다 용량 미지정이면 통과 */
      const ratio=Math.abs(ad.dose-cd.dose)/Math.max(cd.dose,1e-9);
      return ratio<=o.doseToleranceRatio;
    });
    if(!hit){ allMatched=false; reasons.push(`${cd.name} ${cd.time}${cd.dose!=null?` ${cd.dose}mg`:""}에 해당하는 실제 기록을 찾지 못했습니다`); }
  });
  return {matches:allMatched, reasons: allMatched? [] : reasons};
};

/* 예측(체류시간 증가량)과 실측(체류시간 증가량)을 비교한다.
   방향(direction)만 사실로 말하고, "맞았다/틀렸다"는 단정하지 않는다. */
VAL.COMPARE_DEFAULTS = { toleranceMin:30 };
VAL.compareOutcome = function(predictedDeltaMin, actualDeltaMin, opts){
  const o=Object.assign({}, VAL.COMPARE_DEFAULTS, opts||{});
  if(predictedDeltaMin==null || actualDeltaMin==null){
    return {valid:false, reasons:["예측 또는 실측 값이 없어 비교할 수 없습니다"]};
  }
  const errorMin = actualDeltaMin - predictedDeltaMin;
  const denom = Math.max(Math.abs(predictedDeltaMin), 1);
  const errorPct = Math.round((errorMin/denom)*1000)/10;
  let direction;
  if(Math.abs(errorMin)<=o.toleranceMin) direction="close"; /* 예측과 오차범위 이내로 비슷함 */
  else if(errorMin>0) direction="exceeded"; /* 실제가 예측보다 더 좋았음(체류시간이 더 늘어남) */
  else direction="fell_short"; /* 실제가 예측에 못 미침 */
  return {valid:true, predictedDeltaMin, actualDeltaMin, errorMin, errorPct, direction};
};

/* 여러 번의 비교 결과를 모아 평균 오차·경향을 낸다 (표본이 쌓일수록 이 요약이 의미를 가짐). */
VAL.summarize = function(comparisons){
  const valid=(comparisons||[]).filter(c=>c&&c.valid);
  if(!valid.length) return {valid:false, n:0, reasons:["비교할 수 있는 기록이 없습니다"]};
  const meanErrorMin = valid.reduce((s,c)=>s+c.errorMin,0)/valid.length;
  const meanAbsErrorMin = valid.reduce((s,c)=>s+Math.abs(c.errorMin),0)/valid.length;
  const counts={close:0, exceeded:0, fell_short:0};
  valid.forEach(c=>counts[c.direction]=(counts[c.direction]||0)+1);
  return { valid:true, n:valid.length, meanErrorMin, meanAbsErrorMin, counts,
    reasons: valid.length<3? ["표본이 적어(3회 미만) 경향으로 보기는 이릅니다"] : [] };
};

if(typeof module!=="undefined"&&module.exports) module.exports=VAL;
root.SIMVAL = VAL;
})(typeof window!=="undefined"?window:globalThis);
