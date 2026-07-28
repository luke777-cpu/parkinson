/* ============================================================
   약효 비교 테스트 — 결과 문장·인쇄 텍스트 (challenge-report.js)
   판정·권고 없이 기록 사실만 서술하는 고정 템플릿.
   ============================================================ */
(function(root){
"use strict";
const CHG = root.CHG || (typeof require!=="undefined"? require("./challenge-engine.js"):null);

CHG.timeLabel = v=>{ if(!v) return ""; if(/^\d{2}:\d{2}$/.test(v)) return v;
  const d=new Date(v); return isNaN(d)? String(v) : `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`; };
CHG.DISCLAIMER = "이 결과는 사용자가 직접 기록한 비교 기록이며, 진단이나 치료 결정을 대신하지 않습니다. 약의 증량·감량·추가는 반드시 의료진과 상의하십시오.";
CHG.GRAPH_NOTE = "이 그래프는 사용자가 직접 기록한 증상 점수의 변화를 보여 주며, 실제 혈중 약물 농도나 임상적 약효를 직접 측정한 것은 아닙니다.";
CHG.SEVERE_AE_NOTE = "테스트를 중단하고 안전한 곳에서 쉬십시오. 증상이 지속되거나 심하면 의료진과 상의하십시오.";

/* 단일 테스트 결과 요약 문장 (13절 예시 형식) */
CHG.buildResultLines = function(analysis){
  const L=[];
  analysis.stages.forEach(s=>{
    if(s.recorded && s.avgScore!=null)
      L.push(`${CHG.label("stage",s.stage)} 평균 증상 점수: ${s.avgScore}${s.delta!=null?` (복용 전 대비 ${s.delta>0?s.delta+"점 감소":s.delta<0?(-s.delta)+"점 증가":"변화 없음"})`:""}`);
    else L.push(`${CHG.label("stage",s.stage)}: 기록 없음`);
  });
  if(analysis.bestStage) L.push(`가장 큰 변화가 기록된 시점: ${CHG.label("stage",analysis.bestStage.stage)}`);
  if(analysis.maxImprovement!=null) L.push(`복용 전 대비 최대 변화: ${analysis.maxImprovement}점 ${analysis.maxImprovement>=0?"감소":"증가"}`);
  L.push(`처음 약효를 느낀 시점: ${analysis.firstPerceivedStage? CHG.label("stage",analysis.firstPerceivedStage.stage):"기록 없음"}`);
  if(analysis.firstClearStage) L.push(`처음 분명한 약효를 느낀 시점: ${CHG.label("stage",analysis.firstClearStage.stage)}`);
  if(analysis.firstAdverseStage) L.push(`부작용이 처음 기록된 시점: ${CHG.label("stage",analysis.firstAdverseStage.stage)}`);
  L.push(`사용자 종합평가: ${analysis.finalEvaluation? CHG.label("overall",analysis.finalEvaluation.overallEffect):"미평가"}`);
  L.push(`기록된 부작용: ${analysis.worstAdverse? `${CHG.label("severity",analysis.worstAdverse.severity)} ${CHG.label("adverse",analysis.worstAdverse.code)}`:"없음"}`);
  return L;
};

/* 인쇄·공유용 전체 텍스트 */
CHG.buildResultText = function(test){
  const a=CHG.analyzeTest(test);
  const med=test.medication;
  return [
    "약효 비교 테스트 결과",
    `제목: ${test.title||"(제목 없음)"}`,
    `테스트 종류: ${CHG.label("testType",test.testType)}`,
    `약: ${med.name} ${med.dose}${med.dosageForm?` (${med.dosageForm})`:""} · 복용 예정 ${med.scheduledTime||"-"}${med.doseTakenAt?` · 실제 복용 ${CHG.timeLabel(med.doseTakenAt)}`:""}`,
    med.changeDescription? `변경 내용: ${med.changeDescription}`:"",
    `주증상: ${(test.symptoms||[]).map(s=>CHG.symptomLabel(test,s.code)).join(", ")}`,
    "",
    ...CHG.buildResultLines(a),
    "",
    CHG.DISCLAIMER,
  ].filter(x=>x!=="" || true).join("\n");
};

if(typeof module!=="undefined"&&module.exports) module.exports=CHG;
})(typeof window!=="undefined"?window:globalThis);
