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

/* v0.9.26: 목적(임상 문제)별 우선 해석 — 선택한 문제와 직접 관련된 지표를 먼저 말한다.
   goalContext: {goalId, periodDays, occurrences, judged, verdict, medianOnLatencyMin} */
ITP.interpretForGoal = function(goalId, diff, baselineMetrics, scenarioMetrics, goalContext){
  const findings=[], cautions=[];
  const ctx=goalContext||{};
  const dur=m=>{ m=Math.abs(Math.round(m)); return m>=60? `${Math.floor(m/60)}시간 ${m%60?m%60+"분":""}`.trim() : `${m}분`; };
  const bOn=baselineMetrics.onT, sOn=scenarioMetrics.onT;

  if(goalId==="delayed_on"){
    if(bOn!=null && sOn!=null){
      const d=sOn-bOn;
      findings.push(d<0
        ? `유효 ON 도달이 현재안보다 약 ${dur(d)} 빨라질 것으로 계산됩니다 — delayed ON 구간이 짧아질 가능성이 있습니다.`
        : (d>0? `유효 ON 도달이 약 ${dur(d)} 늦어질 것으로 계산됩니다 — delayed ON 개선 방향과는 반대입니다.`
               : `유효 ON 도달 시각은 현재안과 큰 차이가 없을 것으로 계산됩니다.`));
    } else if(sOn!=null && bOn==null){
      findings.push(`현재안에서는 유효 ON 도달이 예상되지 않았으나, 이 가상안에서는 도달이 예상됩니다.`);
    } else {
      findings.push(`이 가상안에서도 유효 ON 도달은 예상되지 않습니다 — delayed ON보다 다른 요인을 함께 살펴야 합니다.`);
    }
    cautions.push(`경구 레보도파의 흡수는 위 배출·식사와 단백질·변비의 영향을 받을 수 있으므로, 용량 변경만으로 지연 원인이 해결된다고 단정할 수 없습니다.`);
  }
  else if(goalId==="incomplete_on"){
    const bPeak=baselineMetrics.peak? Math.round(baselineMetrics.peak.val):null;
    const sPeak=scenarioMetrics.peak? Math.round(scenarioMetrics.peak.val):null;
    if(baselineMetrics.incomplete && !scenarioMetrics.incomplete)
      findings.push(`현재안에서는 유효 ON 기준에 도달하지 못했으나, 가상안에서는 도달할 가능성이 나타나 incomplete ON 개선 후보가 될 수 있습니다.`);
    else if(!baselineMetrics.incomplete && scenarioMetrics.incomplete)
      findings.push(`가상안에서는 유효 ON 기준에 도달하지 못할 것으로 계산됩니다 — 개선 방향과는 반대입니다.`);
    else if(bPeak!=null&&sPeak!=null)
      findings.push(`최고 예상 출력이 ${bPeak} → ${sPeak}로 계산됩니다.`);
    if(scenarioMetrics.dwell80>baselineMetrics.dwell80)
      findings.push(`유효 ON 유지시간이 ${dur(scenarioMetrics.dwell80-baselineMetrics.dwell80)} 늘어날 것으로 계산됩니다.`);
    if(diff.peakOutputDelta>0)
      cautions.push(`예상 최고 출력도 함께 상승하므로 이상운동증이 기록된 구간과 겹치는지 확인해야 합니다.`);
  }
  else if(goalId==="on_failure"){
    findings.push(`복용 후 의미 있는 상승이 없었던 경우에는 용량 부족 외의 원인도 함께 살펴야 합니다.`);
    cautions.push(`흡수 지연 또는 실패, 식사·단백질 영향, 복용 누락, 위장관 요인, 기록 부족 가능성을 함께 확인하세요.`);
  }
  else if(goalId==="wearing_off"){
    if(diff.wearingOffDeltaMin!=null)
      findings.push(diff.wearingOffDeltaMin>0
        ? `출력이 떨어지는 시점이 약 ${dur(diff.wearingOffDeltaMin)} 늦춰질 것으로 계산됩니다.`
        : `출력이 떨어지는 시점이 약 ${dur(diff.wearingOffDeltaMin)} 앞당겨질 것으로 계산됩니다.`);
    if(diff.dwell80DeltaMin>0) findings.push(`유효 ON 유지시간이 ${dur(diff.dwell80DeltaMin)} 늘어날 것으로 계산됩니다.`);
  }
  else if(goalId==="low_gap"){
    if(diff.dwellLowDeltaMin<0) findings.push(`출력 20 미만 구간이 ${dur(diff.dwellLowDeltaMin)} 줄어들 것으로 계산됩니다.`);
    else if(diff.dwellLowDeltaMin>0) findings.push(`출력 20 미만 구간이 ${dur(diff.dwellLowDeltaMin)} 늘어날 것으로 계산됩니다.`);
    cautions.push(`중간 추가 투여는 다음 정규 복용과 효과가 겹쳐 이후 피크가 높아질 수 있으므로, 공백 개선과 중첩 부담을 함께 비교해야 합니다.`);
  }
  else if(goalId==="peak_dysk"){
    if(diff.peakOutputDelta<0) findings.push(`최고 예상 출력이 ${Math.abs(diff.peakOutputDelta)}점 낮아질 것으로 계산됩니다.`);
    else if(diff.peakOutputDelta>0) findings.push(`최고 예상 출력이 ${diff.peakOutputDelta}점 높아져 이상운동증 가능 구간이 늘어날 수 있습니다.`);
  }

  if(ctx.verdict && ctx.occurrences!=null && ctx.judged)
    findings.unshift(`최근 ${ctx.periodDays||7}일 이 복용에서 해당 문제는 ${ctx.judged}회 중 ${ctx.occurrences}회 관찰되었습니다 (${ctx.verdict}).`);
  if(ctx.judged!=null && ctx.judged<3)
    cautions.push(`분석 가능한 사례가 ${ctx.judged}회로 적어 반복 여부를 판단하기 어렵습니다.`);

  cautions.push(`실제 반응은 약효 비교시험으로 확인해야 합니다. 이 계산은 치료 권고가 아니라 가설을 세우기 위한 도구입니다.`);
  const text=[...findings, ...cautions].join(" ");
  if(ITP.violatesSafety(text)) throw new Error("interpretForGoal produced unsafe text");
  return {goalId, findings, cautions, text};
};

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
