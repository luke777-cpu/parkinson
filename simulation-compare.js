/* ============================================================
   simulation-compare.js — Parkinson Medication Simulation Platform v1.0
   책임: 현재안(baseline)과 각 실험안(scenario)의 계산 결과를 수치로 비교한다.
   원칙: 모든 실험안은 baseline을 기준으로 "독립" 계산된 결과를 받는다 —
   이 파일은 계산을 다시 하지 않고, 이미 계산된 결과끼리의 차이만 만든다.
   ============================================================ */
(function(root){
"use strict";
const CMP = {};

/* baselineComputed, scenarioComputed: simulation-engine.js의 computePlan() 반환값 */
CMP.diff = function(baselineComputed, scenarioComputed){
  const b=baselineComputed.metrics, s=scenarioComputed.metrics;
  const bOn=b.onT, sOn=s.onT;
  return {
    onLatencyDeltaMin: (bOn!=null && sOn!=null)? (sOn-bOn) : null,
    onReached: {baseline:bOn!=null, scenario:sOn!=null},
    peakOutputDelta: Math.round((s.peak?s.peak.val:0) - (b.peak?b.peak.val:0)),
    dwell80DeltaMin: s.dwell80 - b.dwell80,
    dwell5079DeltaMin: s.dwell5079 - b.dwell5079,
    dwellLowDeltaMin: s.dwellLow - b.dwellLow,
    wearingOffDeltaMin: (b.wearT!=null && s.wearT!=null)? (s.wearT-b.wearT) : null,
    leddDeltaMg: Math.round(scenarioComputed.ledd.total - baselineComputed.ledd.total),
    incompleteBefore: b.incomplete, incompleteAfter: s.incomplete,
  };
};

/* changes: scenario.changes 배열(설명용 구조체) — 몇 종류의 변경이 섞였는지 판단 */
CMP.changeCount = function(changes){ return (changes||[]).length; };

/* 변경 내용으로 실험안 성격을 자동 분류 — 해석 엔진이 제형·약물 교체 경고를 띄우는 근거 */
CMP.detectScenarioCategory = function(changes){
  const list=changes||[];
  const hasAdd=list.some(c=>c.type==="add");
  const hasRemove=list.some(c=>c.type==="remove");
  if(hasAdd && hasRemove) return "type_change";
  if(list.some(c=>c.type==="dose_change")) return "dose_change";
  if(list.some(c=>c.type==="time_change")) return "time_change";
  if(hasAdd) return "add";
  if(hasRemove) return "remove";
  return "other";
};

/* scenarios: [{id,title,computed,changes}] — baseline 대비 비교용 점수만 계산 (절대 처방 점수 아님) */
CMP.rankScenarios = function(scenarios, baselineComputed){
  return scenarios.map(sc=>{
    const d=CMP.diff(baselineComputed, sc.computed);
    let score=0;
    if(d.onLatencyDeltaMin!=null) score += d.onLatencyDeltaMin<0? Math.min(3,-d.onLatencyDeltaMin/15) : -Math.min(2,d.onLatencyDeltaMin/20);
    score += Math.min(3, d.dwell80DeltaMin/30);
    score -= Math.min(2, d.dwellLowDeltaMin>0? d.dwellLowDeltaMin/30 : 0);
    score -= Math.min(2, d.peakOutputDelta>15? (d.peakOutputDelta-15)/10 : 0); /* 과도한 피크 상승은 감점 */
    if(CMP.changeCount(sc.changes)>1) score -= 1; /* 다중 변경 신뢰도 감점 */
    return {id:sc.id, title:sc.title, diff:d, comparativeScore:Math.round(score*10)/10};
  });
};

/* 실험안들 사이에 실질적 차이가 있는지 — 없으면 "균형 후보"를 고르지 않는다 */
CMP.MIN_SCORE_GAP = 0.5;
CMP.hasMeaningfulDifference = function(rankedScenarios){
  if(!rankedScenarios.length) return false;
  const sorted=[...rankedScenarios].sort((a,b)=>b.comparativeScore-a.comparativeScore);
  const top=sorted[0];
  if(top.comparativeScore<=0) return false; /* 현재안 대비 개선이 없음 */
  if(sorted.length>1 && (top.comparativeScore-sorted[1].comparativeScore)<CMP.MIN_SCORE_GAP) return false;
  return true;
};

CMP.overallComparison = function(rankedScenarios){
  if(!rankedScenarios.length) return null;
  const byOnLatency=[...rankedScenarios].filter(r=>r.diff.onLatencyDeltaMin!=null).sort((a,b)=>a.diff.onLatencyDeltaMin-b.diff.onLatencyDeltaMin)[0];
  const byDwell80=[...rankedScenarios].sort((a,b)=>b.diff.dwell80DeltaMin-a.diff.dwell80DeltaMin)[0];
  const byLowPeak=[...rankedScenarios].sort((a,b)=>a.diff.peakOutputDelta-b.diff.peakOutputDelta)[0];
  const byBalance=[...rankedScenarios].sort((a,b)=>b.comparativeScore-a.comparativeScore)[0];
  const meaningful=CMP.hasMeaningfulDifference(rankedScenarios);
  return {
    fastestOnLatency: byOnLatency? byOnLatency.id : null,
    longestTargetDuration: byDwell80? byDwell80.id : null,
    lowestPeakBurden: byLowPeak? byLowPeak.id : null,
    /* 차이가 뚜렷하지 않으면 균형 후보를 고르지 않는다 */
    mostBalancedScenario: (meaningful && byBalance)? byBalance.id : null,
    meaningfulDifference: meaningful,
  };
};

if(typeof module!=="undefined"&&module.exports) module.exports=CMP;
root.SIMCMP=CMP;
})(typeof window!=="undefined"?window:globalThis);
