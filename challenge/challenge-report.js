/* ============================================================
   약효 비교 테스트 v2 — 해석·보고서 문장 (challenge-report.js)
   §15 허용 해석만 결정론적 조건으로 생성. 치료 판단 없음.
   ============================================================ */
(function(root){
"use strict";
const CHG = root.CHG || (typeof require!=="undefined"? require("./challenge-engine.js"):null);

CHG.DISCLAIMER = "이 결과는 사용자가 직접 기록한 비교 기록이며, 진단이나 치료 결정을 대신하지 않습니다. 약의 증량·감량·추가는 반드시 의료진과 상의하십시오.";
CHG.GRAPH_NOTE = "이 그래프는 사용자가 직접 기록한 증상 점수의 변화를 보여 주며, 실제 혈중농도나 임상적 약효를 직접 측정한 것은 아닙니다.";
CHG.SEVERE_AE_NOTE = "테스트를 중단하고 안전한 곳에서 쉬십시오. 증상이 지속되거나 심하면 의료진과 상의하십시오.";
CHG.CHANGE_NOTE = "실제 약 변경 시험은 의료진과 상의하여 변경된 처방만 기록하십시오.";

CHG.timeLabel = v=>{ if(!v) return ""; if(/^\d{2}:\d{2}$/.test(v)) return v;
  const d=new Date(v); return isNaN(d)? String(v) : `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`; };

/* ---------- 단일 시험 허용 해석 (§15) ---------- */
CHG.buildInterpretation = function(analysis){
  const out=[]; const gs=analysis.groupSummary;
  const gname=g=>CHG.label("group",g);
  Object.entries(gs).forEach(([g,s])=>{
    if(s.firstChangeStage) out.push(`이번 시험에서는 복용 ${s.firstChangeStage.minutes}분 이후 ${gname(g)} 점수 감소가 기록되었습니다.`);
    if(s.bestStage) out.push(`${gname(g)}은(는) ${s.bestStage.minutes}분에 가장 낮은 점수를 보였습니다.`);
    if(s.rebound120) out.push(`120분 시점에는 ${gname(g)} 점수가 다시 상승한 것으로 기록되었습니다.`);
    if(s.baseline!=null && !s.firstChangeStage && s.maxImprovement!=null && s.maxImprovement<=0)
      out.push(`${gname(g)}에는 뚜렷한 변화가 기록되지 않았습니다.`);
  });
  /* 그룹 간 양상 차이 (운동 vs 비운동) */
  const mo=gs.motor, nm=gs.nonmotor;
  if(mo&&nm&&mo.maxImprovement!=null&&nm.maxImprovement!=null&&Math.abs(mo.maxImprovement-nm.maxImprovement)>=1)
    out.push("비운동 증상은 운동 증상과 다른 변화 양상을 보였습니다.");
  if(analysis.firstClearStage) out.push(`처음 분명한 약효 체감은 복용 ${analysis.firstClearStage.minutes}분에 기록되었습니다.`);
  if(!out.length) out.push("이번 시험의 기록을 표와 그래프로 확인해 보십시오.");
  return out;
};

/* ---------- 기준·변경 비교 해석 ---------- */
CHG.buildComparisonNotes = function(cmp){
  const notes=[]; const A=cmp.base, B=cmp.after;
  const fa=A.firstPerceivedStage&&A.firstPerceivedStage.minutes, fb=B.firstPerceivedStage&&B.firstPerceivedStage.minutes;
  if(fa!=null&&fb!=null&&fb<fa) notes.push("변경 시험에서는 기준 시험보다 약효 체감이 빨리 기록되었습니다.");
  if(fa!=null&&fb!=null&&fb>fa) notes.push("변경 시험에서는 기준 시험보다 약효 체감이 늦게 기록되었습니다.");
  const ga=(A.groupSummary.motor||{}).maxImprovement, gb=(B.groupSummary.motor||{}).maxImprovement;
  if(ga!=null&&gb!=null&&gb>ga) notes.push("변경 시험에서 운동 증상의 더 큰 점수 감소가 기록되었습니다.");
  if(ga!=null&&gb!=null&&gb<ga) notes.push("변경 시험에서 운동 증상 점수 감소가 더 작게 기록되었습니다.");
  const dA=A.worstAdverse&&A.worstAdverse.code==="dyskinesia"? A.worstAdverse.score:0;
  const dB=B.worstAdverse&&B.worstAdverse.code==="dyskinesia"? B.worstAdverse.score:0;
  if(gb!=null&&ga!=null&&gb>ga&&dB>dA) notes.push("변경 시험에서는 증상 개선과 함께 이상운동증 점수도 증가했습니다.");
  else if((B.worstAdverse?B.worstAdverse.score:0)>(A.worstAdverse?A.worstAdverse.score:0)) notes.push("변경 시험에서 더 높은 부작용 점수가 기록되었습니다.");
  if(!notes.length) notes.push("두 시험의 기록을 위 표와 그래프로 비교해 보십시오.");
  return notes;
};

/* ---------- 인쇄·공유 텍스트 ---------- */
CHG.buildResultText = function(test){
  const a=CHG.analyzeTest(test);
  const lines=[];
  lines.push("약효 비교 테스트 결과 (v2)");
  lines.push(`제목: ${test.title||"(제목 없음)"} · ${CHG.label("role",test.comparisonRole)}`);
  lines.push(`시험 종류: ${CHG.label("testType",test.testType)}`);
  (test.medications||[]).forEach(m=>lines.push(`약: ${m.name} ${m.doseText||""}${m.form?` (${m.form})`:""}`));
  if(test.doseTakenAt) lines.push(`실제 복용 시각: ${CHG.timeLabel(test.doseTakenAt)}`);
  if(test.changeDescription) lines.push(`변경 내용: ${test.changeDescription}`);
  lines.push(`선택 증상: ${(test.symptoms||[]).map(s=>CHG.symptomLabel(test,s.code)).join(", ")}`);
  lines.push("");
  a.groups.forEach(g=>{
    const s=a.groupSummary[g];
    lines.push(`[${CHG.label("group",g)}]`);
    CHG.STAGES.forEach(st=>{
      const v=s.perStage[st.stage];
      lines.push(`  ${st.ko}: ${v==null?"기록 없음":v}${st.stage!=="baseline"&&s.delta[st.stage]!=null?` (기준 대비 ${s.delta[st.stage]>0?s.delta[st.stage]+"점 감소":s.delta[st.stage]<0?(-s.delta[st.stage])+"점 증가":"변화 없음"})`:""}`);
    });
    if(s.bestStage) lines.push(`  가장 좋은 시점: ${s.bestStage.minutes}분 (최대 개선 ${s.maxImprovement}점)`);
  });
  lines.push("");
  lines.push(`최초 체감: ${a.firstPerceivedStage? a.firstPerceivedStage.minutes+"분":"기록 없음"} · 분명한 체감: ${a.firstClearStage? a.firstClearStage.minutes+"분":"기록 없음"}`);
  lines.push(`부작용 최고: ${a.worstAdverse? `${CHG.label("adverse",a.worstAdverse.code)} ${a.worstAdverse.score}점 (${a.worstAdverse.minutes}분)`:"기록 없음"}`);
  lines.push(`사용자 종합평가: ${a.finalEvaluation? CHG.label("overall",a.finalEvaluation.overallEffect):"미평가"}`);
  lines.push("");
  CHG.buildInterpretation(a).forEach(x=>lines.push("- "+x));
  lines.push("");
  lines.push(CHG.DISCLAIMER);
  return lines.join("\n");
};

if(typeof module!=="undefined"&&module.exports) module.exports=CHG;
})(typeof window!=="undefined"?window:globalThis);
