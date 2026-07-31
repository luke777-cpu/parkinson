/* ============================================================
   simulation-interpret.js — Parkinson Medication Simulation Platform v1.0
   책임: simulation-compare.js가 만든 수치 차이를 한국어 문장으로 바꾼다.
   절대 금지: "증량하십시오", "이 약이 맞습니다", "가장 좋습니다", "안전합니다" 같은
   확정·권고 표현. 허용: "예상됩니다", "가능성이 있습니다", "기록상", "비교 지표상".
   해석과 계산을 분리해 두면 이 규칙을 한 곳에서만 강제하면 된다.
   ============================================================ */
(function(root){
"use strict";
const ITP = {};

/* 이 파일이 생성하는 모든 문장은 반드시 이 목록을 통과해야 한다 (테스트에서도 사용) */
ITP.BANNED_PATTERNS = [
  /증량하십시오/, /감량하십시오/, /이 약(?:이|으로)\s*(?:맞습니다|바꾸십시오|변경하십시오)/,
  /가장\s*좋습니다/, /가장\s*적절합니다/, /안전합니다/, /효과적입니다/,
  /추천합니다/, /권장합니다/, /처방을?\s*바꾸십시오/, /치료가?\s*성공/, /반응\s*양성/,
];
ITP.violatesSafety = function(text){ return ITP.BANNED_PATTERNS.some(re=>re.test(text||"")); };

function fmtT(tMin){ if(tMin==null) return "도달하지 못함(예상)"; const t=((tMin%1440)+1440)%1440; const h=Math.floor(t/60), m=Math.round(t%60); return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`; }
function fmtDur(mins){ mins=Math.abs(Math.round(mins)); if(mins>=60) return `${Math.floor(mins/60)}시간 ${mins%60?mins%60+"분":""}`.trim(); return `${mins}분`; }

/* 단일 실험안 해석 — findings(관찰) / cautions(주의) / confidence(신뢰도) */
ITP.interpretScenario = function(scenario, diff, dataQuality){
  const findings=[], cautions=[];
  const changeCount=(scenario.changes||[]).length;

  if(diff.onLatencyDeltaMin!=null){
    if(diff.onLatencyDeltaMin<-5) findings.push(`현재안보다 ON(출력 80 이상) 도달이 약 ${fmtDur(diff.onLatencyDeltaMin)} 빨라질 것으로 예상됩니다.`);
    else if(diff.onLatencyDeltaMin>5) findings.push(`현재안보다 ON 도달이 약 ${fmtDur(diff.onLatencyDeltaMin)} 늦어질 것으로 예상됩니다.`);
    else findings.push(`ON 도달 시각은 현재안과 비교해 큰 차이가 없을 것으로 예상됩니다.`);
  } else if(diff.onReached.scenario && !diff.onReached.baseline){
    findings.push(`현재안에서는 ON 도달이 예상되지 않았으나, 이 실험안에서는 ON 도달이 예상됩니다.`);
  } else if(!diff.onReached.scenario){
    findings.push(`이 실험안에서도 ON(출력 80 이상) 도달은 예상되지 않습니다.`);
  }

  if(diff.dwell80DeltaMin>15) findings.push(`출력 80 이상 유지 시간이 ${fmtDur(diff.dwell80DeltaMin)} 증가할 것으로 예상됩니다.`);
  else if(diff.dwell80DeltaMin<-15) findings.push(`출력 80 이상 유지 시간이 ${fmtDur(diff.dwell80DeltaMin)} 감소할 것으로 예상됩니다.`);

  if(diff.peakOutputDelta>=15){ findings.push(`최고 예상 출력이 ${diff.peakOutputDelta}점 높아지지만, 피크가 커져 이상운동증 가능성이 다소 증가할 수 있습니다.`); }
  else if(diff.peakOutputDelta>0) findings.push(`최고 예상 출력이 ${diff.peakOutputDelta}점 높아질 것으로 예상됩니다.`);
  else if(diff.peakOutputDelta<0) findings.push(`최고 예상 출력이 ${Math.abs(diff.peakOutputDelta)}점 낮아질 것으로 예상됩니다.`);

  if(diff.dwellLowDeltaMin<-15) findings.push(`출력 20 미만 구간이 ${fmtDur(diff.dwellLowDeltaMin)} 줄어들 것으로 예상됩니다.`);
  else if(diff.dwellLowDeltaMin>15) findings.push(`출력 20 미만 구간이 ${fmtDur(diff.dwellLowDeltaMin)} 늘어날 것으로 예상됩니다.`);

  if(diff.wearingOffDeltaMin!=null){
    if(diff.wearingOffDeltaMin>15) findings.push(`wearing-off 예상 시각이 ${fmtDur(diff.wearingOffDeltaMin)} 지연될 것으로 예상됩니다.`);
    else if(diff.wearingOffDeltaMin<-15) findings.push(`wearing-off 예상 시각이 ${fmtDur(diff.wearingOffDeltaMin)} 앞당겨질 것으로 예상됩니다.`);
  }

  if(changeCount>1) cautions.push(`이 실험안에는 ${changeCount}가지 변경이 포함되어 있어 어떤 변경이 결과에 영향을 미쳤는지 구분하기 어렵습니다.`);
  if(!dataQuality || !dataQuality.personal){
    const why=(dataQuality&&dataQuality.reasons&&dataQuality.reasons.length)? ` (${dataQuality.reasons.join(" · ")})` : "";
    cautions.push(`실제 출력 기록이 충분하지 않아 신뢰도 낮음${why}.`);
  }
  if(dataQuality && dataQuality.confidenceReasons && dataQuality.confidenceReasons.length) cautions.push(`신뢰도 낮음 — ${dataQuality.confidenceReasons.join(" · ")}.`);
  if((scenario.category==="type_change")) cautions.push(`현재 모델에서는 제형·약물 차이를 정확히 구분할 개인 자료가 부족합니다. 실제 비교 테스트가 필요합니다.`);

  const confidence = (dataQuality&&dataQuality.personal && changeCount<=1 && !(dataQuality.confidenceReasons&&dataQuality.confidenceReasons.length))? "medium" : "low";
  const text=[...findings, ...cautions].join(" ") + " 이는 단순 시뮬레이션 결과이며 실제 용량 또는 약물 변경을 권고하는 결과가 아닙니다.";
  if(ITP.violatesSafety(text)) throw new Error("interpretScenario produced unsafe text");
  return {findings, cautions, confidence, confidenceReasons:(dataQuality&&dataQuality.confidenceReasons)||[], text};
};

/* 여러 실험안 종합 해석 — "추천"이 아니라 비교 지표상 표현만 사용 */
ITP.interpretOverall = function(rankedScenarios, overall, dataQuality){
  if(!rankedScenarios.length) return {text:"", cautions:[]};
  const cautions=[];
  if(!dataQuality || !dataQuality.personal){
    const text=`실제 출력 기록이 부족하여 실험안들의 차이를 안정적으로 해석하기 어렵습니다. 일반 추정 모델을 기준으로 한 참고용 비교입니다.`;
    return {text, cautions:["실제 출력 기록이 부족하여 실험안들의 차이를 안정적으로 해석하기 어렵습니다."]};
  }
  /* 검토 반영: 점수가 같거나 현재안과 차이가 없으면 하나를 고르지 않는다 */
  if(!overall || overall.meaningfulDifference===false || !overall.mostBalancedScenario){
    const text="실험안들 사이에 뚜렷한 차이가 나타나지 않았습니다. 이는 단순 시뮬레이션 결과이며 실제 반응은 비교 테스트로 확인해야 합니다.";
    return {text, cautions:[]};
  }
  const balanced=rankedScenarios.find(r=>r.id===overall.mostBalancedScenario);
  let text="";
  if(balanced) text=`${balanced.title} 조건은 비교 지표상 효과 증가와 피크 상승 사이의 균형이 상대적으로 완만하게 나타납니다.`;
  text += " 그러나 이는 단순 시뮬레이션 결과이며 실제 용량 또는 약물 변경을 권고하는 결과가 아닙니다. 실제 반응은 비교 테스트로 확인해야 합니다.";
  if(ITP.violatesSafety(text)) throw new Error("interpretOverall produced unsafe text");
  return {text, cautions};
};

if(typeof module!=="undefined"&&module.exports) module.exports=ITP;
root.SIMITP=ITP;
})(typeof window!=="undefined"?window:globalThis);
