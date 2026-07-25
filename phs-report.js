/* =====================================================================
 * phs-report.js — Patient History Summary 보고서 엔진 + 한국어 템플릿 + 안전 필터
 * ---------------------------------------------------------------------
 * 입력: patientProfile + observationSurvey(+end) + analysisResult + confidenceResult
 * 출력: 구조화된 reportResult JSON (REPORT_ENGINE_SPEC §9)
 * 규칙: 임상 분석을 재계산하지 않는다. 원자료를 직접 읽지 않는다.
 *       모든 문장은 templatesKo에서만 생성한다 (결정론적, 무작위 표현 금지).
 * ===================================================================== */
(function(global){
"use strict";
const PHS = global.PHS || (global.PHS={});

/* ---------- 용어 (환자용 쉬운 말 ↔ 후보 해석 용어) ---------- */
PHS.terminologyKo = {
  delayed_response: {plain:"약을 먹은 뒤 몸이 좋아지기까지 오래 걸림", candidate:"반응 지연 후보"},
  incomplete_response: {plain:"약을 먹어도 평소 가장 좋은 상태까지 올라가지 못함", candidate:"불완전 반응 후보"},
  no_clear_response: {plain:"약을 먹었지만 뚜렷하게 좋아지지 않음", candidate:"뚜렷한 반응이 확인되지 않은 후보"},
  wearing_off: {plain:"다음 약 시간 전에 몸이 먼저 가라앉음", candidate:"웨어링오프 의심 패턴"},
  afternoon_decline: {plain:"오후에 몸 상태가 내려감", candidate:"오후 출력 저하"},
  freezing: {plain:"걸을 때 발이 붙는 느낌", candidate:"보행동결"},
  dyskinesia: {plain:"몸이 저절로 크게 흔들리는 움직임", candidate:"이상운동증"},
  dystonia: {plain:"근육이 뒤틀리듯 당겨짐", candidate:"근긴장이상"},
  tremor: {plain:"떨림", candidate:"떨림"},
  brady: {plain:"움직임이 느려짐", candidate:"서동"},
  gait: {plain:"걷기 어려움", candidate:"보행 장애"},
  fall: {plain:"넘어질 뻔함/넘어짐", candidate:"낙상 위험"},
  pain: {plain:"통증", candidate:"통증"},
  anxiety: {plain:"불안", candidate:"불안"},
  sleep: {plain:"잠을 잘 못 잠", candidate:"수면 문제"},
};
const RELATION_KO = {
  high_output_associated:"출력이 높은 시기와 시간적 연관성이 관찰됨",
  low_output_associated:"출력이 낮은 시기와 시간적 연관성이 관찰됨",
  rising_phase_associated:"출력 상승기와 시간적 연관성이 관찰됨",
  falling_phase_associated:"출력 하강기와 시간적 연관성이 관찰됨",
  morning_associated:"오전 시간대와 시간적 연관성이 관찰됨",
  mixed:"일정한 패턴이 확인되지 않음",
  insufficient_data:"기록이 적어 패턴 평가가 어려움",
};
const CONF_KO = {high:"높음", moderate:"보통", low:"낮음"};

/* ---------- 한국어 문장 템플릿 (결정론적) ---------- */
PHS.templatesKo = {
  diagnosisHistory: ({years}) => years!=null? `파킨슨병 진단 후 약 ${years}년 경과한 환자입니다.` : `파킨슨병으로 추적 관찰 중인 환자입니다.`,
  observationPurpose: () => `최근 일중 기능 변동과 약물 반응의 불규칙성을 확인하기 위해 출력(0~100) 중심 기록을 시행했습니다.`,
  patientComplaint: ({text}) => `환자는 "${text}"를 주된 어려움으로 보고했습니다.`,
  outputRange: ({min,max,avg}) => `관찰기간 동안 출력은 ${min}점에서 ${max}점 사이로 변동했으며 평균은 ${avg}점이었습니다.`,
  dailyRange: ({range}) => `하루 안에서 평균 ${range}점 폭의 변동이 기록되었습니다.`,
  timePattern: ({stable,variable}) => {
    const parts=[];
    if(stable) parts.push(`출력이 비교적 안정적인 시간대는 ${stable}이었습니다`);
    if(variable) parts.push(`변동이 가장 컸던 시간대는 ${variable}이었습니다`);
    return parts.length? parts.join(", ")+"." : "";
  },
  delayedCandidate: ({count,minutes}) => `오전 첫 복용 후 의미 있는 출력 상승까지 중앙값 ${minutes}분이 소요되었으며, 반응 지연 후보가 ${count}회 관찰되었습니다.`,
  medianRiseOnly: ({minutes}) => `오전 첫 복용 후 의미 있는 출력 상승까지 중앙값 ${minutes}분이 소요되었습니다.`,
  incompleteCandidate: ({count}) => `복용 후 출력이 상승했지만 평소 기대 수준까지 도달하지 못한 후보가 ${count}회 관찰되었습니다.`,
  noClearCandidate: ({count}) => `복용 후 충분한 관찰에도 의미 있는 출력 상승이 확인되지 않은 후보가 ${count}회 있었습니다.`,
  wearingOffCandidate: ({days}) => `다음 복용 시간 전에 출력이 먼저 하강하는 양상이 ${days}일에 걸쳐 반복 기록되어 웨어링오프 의심 패턴이 관찰되었습니다.`,
  symptomLine: ({label,count,avgOut,relation,dur}) => {
    let s=`${label} ${count}회 기록`;
    if(avgOut!=null) s+=` (발생 시 평균 출력 ${avgOut}점`;
    if(dur!=null) s+= avgOut!=null? `, 중앙값 지속 ${dur}분)` : ` (중앙값 지속 ${dur}분)`;
    else if(avgOut!=null) s+=`)`;
    if(relation) s+=` — ${relation}`;
    return s+".";
  },
  lifestyleLine: ({label,n}) => `${label}이(가) ${n}회(일) 기록되어 출력 변동과의 시간적 연관성 검토가 가능하나, 인과관계는 확정할 수 없습니다.`,
  missingDataLimitation: () => `일부 시간대는 기록이 부족하여 체류시간과 약물 반응을 정확히 평가하기 어려웠습니다.`,
  lowRecordLimitation: ({days}) => `기록 일수가 ${days}일로 적어 해석의 신뢰도가 제한적입니다.`,
  confidenceLine: ({level,score}) => `기록 데이터 신뢰도: ${CONF_KO[level]||level} (${score}/100).`,
  reviewNeeded: () => `상기 소견은 기록 기반 후보 관찰이며, 최종 판단을 위해 담당 의료진의 검토가 필요합니다.`,
  currentMedLine: ({name,dose,perDay}) => `${name}${dose?` ${dose}mg`:""}${perDay?` — 관찰기간 일평균 ${perDay}회 복용 기록`:""}`,
  disclaimer: () => `본 Patient History Summary는 환자가 입력한 설문, 출력 기록, 약 복용 및 증상 기록을 바탕으로 자동 생성되었습니다. 본 보고서는 진단이나 약물 조정 지시를 제공하지 않으며, 최종 임상 판단은 담당 의료진이 시행해야 합니다.`,
};
/* 향후 영어 템플릿 자리 (구조 동일) */
PHS.templatesEn = null;

/* ---------- 안전 필터 (금지 표현 → 허용 표현) ---------- */
PHS.SAFETY_RULES = [
  {re:/delayed\s*ON\s*입니다/gi, to:"반응 지연 후보가 관찰되었습니다"},
  {re:/ON\s*failure\s*입니다/gi, to:"뚜렷한 반응이 확인되지 않은 후보가 있었습니다"},
  {re:/확진되었습니다/g, to:"기록상 의심됩니다"},
  {re:/약을\s*(반드시\s*)?증량(해야|하십시오|해야\s*합니다)[^.\s]*/g, to:"담당 의료진의 검토가 필요합니다"},
  {re:/약을\s*(반드시\s*)?감량(해야|하십시오|해야\s*합니다)[^.\s]*/g, to:"담당 의료진의 검토가 필요합니다"},
  {re:/복용\s*시간을\s*반드시\s*바꾸십시오/g, to:"복용 시간에 대한 담당 의료진의 검토가 필요합니다"},
  {re:/(특정\s*약|이\s*약)이\s*원인입니다/g, to:"시간적 연관성이 관찰되었으나 인과관계는 확정할 수 없습니다"},
  {re:/약물\s*과다\s*때문입니다/g, to:"약물과의 시간적 연관성이 관찰되었으나 인과관계는 확정할 수 없습니다"},
];
PHS.safetyFilterText = function(text){
  if(typeof text!=="string") return text;
  let out=text;
  PHS.SAFETY_RULES.forEach(r=>{ out=out.replace(r.re, r.to); });
  return out;
};
PHS.applySafetyFilter = function(node){
  if(typeof node==="string") return PHS.safetyFilterText(node);
  if(Array.isArray(node)) return node.map(PHS.applySafetyFilter);
  if(node && typeof node==="object"){
    const out={}; Object.entries(node).forEach(([k,v])=>{ out[k]=PHS.applySafetyFilter(v); }); return out;
  }
  return node;
};
/* 자동 안전 검사: 생성된 보고서 전체 문자열에 금지 표현이 남아있는지 확인 */
PHS.PROHIBITED_PATTERNS = [/delayed\s*ON입니다/i, /ON\s*failure입니다/i, /약을\s*증량해야/, /약을\s*감량해야/, /복용시간을\s*반드시\s*바꾸/, /확진되었습니다/, /원인입니다/, /과다\s*때문입니다/];
PHS.checkReportSafety = function(reportJson){
  const bad=[];
  (function walk(n,path){
    if(typeof n==="string"){ PHS.PROHIBITED_PATTERNS.forEach(p=>{ if(p.test(n)) bad.push({path, pattern:String(p), text:n}); }); }
    else if(Array.isArray(n)) n.forEach((v,i)=>walk(v,`${path}[${i}]`));
    else if(n&&typeof n==="object") Object.entries(n).forEach(([k,v])=>walk(v,`${path}.${k}`));
  })(reportJson,"report");
  return bad;
};

/* ---------- 문제 코드 → 한국어 라벨 ---------- */
PHS.problemLabelKo = function(code){
  const t=PHS.terminologyKo[code];
  return t? t.candidate : code;
};

/* ---------- CC 생성 (§10: primary + 최대 2개 secondary) ---------- */
function buildCC(startSurvey){
  if(!startSurvey) return "출력 변동 및 약물 반응 평가";
  const primary=startSurvey.primaryProblem||null;
  const secondary=(startSurvey.chiefProblems||[]).filter(c=>c!==primary).slice(0,2);
  const parts=[primary, ...secondary].filter(Boolean).map(PHS.problemLabelKo);
  return parts.length? parts.join(", ") : "출력 변동 및 약물 반응 평가";
}

/* ---------- HPI 생성 (§11 고정 순서) ---------- */
function buildHPI({profile, startSurvey, analysis, confidence}, T){
  const s=[];
  s.push(T.diagnosisHistory({years:profile&&profile.diagnosisYears!=null? profile.diagnosisYears : null})); //1 진단 경과
  s.push(T.observationPurpose()); //2 관찰 목적
  if(startSurvey&&startSurvey.primaryProblem) //3 환자 보고 주호소
    s.push(T.patientComplaint({text:(PHS.terminologyKo[startSurvey.primaryProblem]||{}).plain||startSurvey.primaryProblem}));
  const o=analysis.output;
  if(o.average!=null){ //4 출력 범위·평균
    s.push(T.outputRange({min:o.minimum,max:o.maximum,avg:o.average}));
    if(o.averageDailyRange!=null) s.push(T.dailyRange({range:o.averageDailyRange}));
  }
  const tp=T.timePattern({stable:o.mostStablePeriod,variable:o.mostVariablePeriod}); //5 시간대 패턴
  if(tp) s.push(tp);
  const m=analysis.medicationResponse.morningFirstDose; //6 약물 반응
  if(m.medianRiseMinutes!=null){
    if(m.delayedCandidates>0) s.push(T.delayedCandidate({count:m.delayedCandidates,minutes:m.medianRiseMinutes}));
    else s.push(T.medianRiseOnly({minutes:m.medianRiseMinutes}));
  }
  if(m.incompleteCandidates>0) s.push(T.incompleteCandidate({count:m.incompleteCandidates}));
  if(m.noClearResponseCandidates>0) s.push(T.noClearCandidate({count:m.noClearResponseCandidates}));
  if(analysis.medicationResponse.wearingOff.candidate) s.push(T.wearingOffCandidate({days:analysis.medicationResponse.wearingOff.days}));
  Object.values(analysis.symptoms).forEach(sy=>{ //7 동반 증상
    if(sy.count>=2) s.push(T.symptomLine({label:sy.labelKo,count:sy.count,avgOut:sy.averageOutputAtEvent,relation:RELATION_KO[sy.relation],dur:sy.medianDurationMinutes}));
  });
  analysis.lifestyle.associations.slice(0,2).forEach(a=>{ //8 생활 연관성
    s.push(T.lifestyleLine({label:a.labelKo,n:a.supportingEvents}));
  });
  //9 자료 한계
  if(analysis.output.missingMinutes>0) s.push(T.missingDataLimitation());
  if(analysis.period.recordedDays<3) s.push(T.lowRecordLimitation({days:analysis.period.recordedDays}));
  return s.filter(Boolean).join(" ");
}

/* ---------- 임상 검토 포인트 ---------- */
function buildReviewPoints(analysis, startSurvey){
  const pts=[];
  const m=analysis.medicationResponse.morningFirstDose;
  if(m.delayedCandidates>0) pts.push(`오전 첫 복용 후 반응 지연 후보 ${m.delayedCandidates}회 — 담당 의료진의 검토가 필요합니다.`);
  if(m.incompleteCandidates>0) pts.push(`불완전한 출력 회복이 의심되는 기록 ${m.incompleteCandidates}회 — 담당 의료진의 검토가 필요합니다.`);
  if(m.noClearResponseCandidates>0) pts.push(`뚜렷한 반응이 확인되지 않은 후보 ${m.noClearResponseCandidates}회 — 담당 의료진의 검토가 필요합니다.`);
  if(analysis.medicationResponse.wearingOff.candidate) pts.push(`다음 복용 전 출력 하강의 반복 기록 — 웨어링오프 의심 패턴에 대한 검토가 필요합니다.`);
  Object.values(analysis.symptoms).forEach(sy=>{
    if(sy.count>=2 && (sy.relation==="high_output_associated"||sy.relation==="low_output_associated"))
      pts.push(`${sy.labelKo}의 ${RELATION_KO[sy.relation]} — 인과관계는 확정할 수 없으며 검토가 필요합니다.`);
  });
  if(!pts.length) pts.push("기록상 뚜렷한 반복 패턴 후보는 확인되지 않았습니다. 담당 의료진의 종합 검토가 필요합니다.");
  return pts;
}

/* ---------- 환자 질문 (§12 순서: 자유 질문 → 선택 질문 → 제안 질문[별도 표기]) ---------- */
function buildQuestions(startSurvey, endSurvey, analysis){
  const qs=[];
  if(startSurvey&&startSurvey.freeQuestion) qs.push({type:"free", text:startSurvey.freeQuestion}); // 환자가 입력한 그대로
  (startSurvey&&startSurvey.selectedPatientQuestions||[]).forEach(q=>qs.push({type:"selected", text:q}));
  if(endSurvey&&endSurvey.additionalClinicianQuestion) qs.push({type:"free", text:endSurvey.additionalClinicianQuestion});
  /* 반복 패턴 기반 제안 질문 — 별도 라벨, 지시 아님 */
  const m=analysis.medicationResponse.morningFirstDose;
  if(m.delayedCandidates>=2) qs.push({type:"suggested", text:"오전 첫 복용 후 반응이 늦어지는 기록이 반복되는데, 이에 대해 어떻게 보시는지 여쭙고 싶습니다."});
  if(analysis.medicationResponse.wearingOff.candidate) qs.push({type:"suggested", text:"다음 약 시간 전에 몸이 먼저 가라앉는 기록이 반복되는데, 검토를 부탁드리고 싶습니다."});
  return qs;
}

/* ---------- 보고서 엔진 (총괄) ---------- */
PHS.buildReport = function({profile, startSurvey, endSurvey, analysis, confidence, medsList}){
  const T=PHS.templatesKo;
  const cc=buildCC(startSurvey);
  const hpi=buildHPI({profile,startSurvey,analysis,confidence}, T);
  const m=analysis.medicationResponse, o=analysis.output;
  const keyResults=[];
  if(o.average!=null) keyResults.push(T.outputRange({min:o.minimum,max:o.maximum,avg:o.average}));
  if(m.morningFirstDose.medianRiseMinutes!=null) keyResults.push(T.medianRiseOnly({minutes:m.morningFirstDose.medianRiseMinutes}));
  const symTop=Object.values(analysis.symptoms).sort((a,b)=>b.count-a.count)[0];
  if(symTop&&symTop.count>0) keyResults.push(T.symptomLine({label:symTop.labelKo,count:symTop.count,avgOut:symTop.averageOutputAtEvent,relation:RELATION_KO[symTop.relation],dur:symTop.medianDurationMinutes}));
  keyResults.push(T.confidenceLine({level:confidence.overall,score:confidence.score}));
  const mainDailyPattern = (()=>{
    const parts=[];
    const tp=T.timePattern({stable:o.mostStablePeriod,variable:o.mostVariablePeriod});
    if(tp) parts.push(tp);
    if(m.wearingOff.candidate) parts.push(T.wearingOffCandidate({days:m.wearingOff.days}));
    return parts.join(" ") || "시간대별 패턴을 평가하기에 기록이 충분하지 않습니다.";
  })();
  const questions=buildQuestions(startSurvey,endSurvey,analysis);
  const reviewPoints=buildReviewPoints(analysis,startSurvey);
  /* 현재 약물: 관찰기간 복약 기록 기준 (등록된 약 목록 참조) */
  const doseDays={};
  analysis._adapted.medicationEvents.forEach(me=>{
    const k=me.name; (doseDays[k]||(doseDays[k]={n:0,dose:me.doseMg})).n++;
  });
  const days=Math.max(1,analysis.period.recordedDays);
  const currentMedication=Object.entries(doseDays).map(([name,v])=>
    T.currentMedLine({name,dose:v.dose,perDay:(v.n/days).toFixed(1)}));
  const limitations=[];
  if(o.missingMinutes>0) limitations.push(T.missingDataLimitation());
  if(analysis.period.recordedDays<3) limitations.push(T.lowRecordLimitation({days:analysis.period.recordedDays}));
  confidence.reasons.forEach(r=>limitations.push(r));
  const report={
    title:"Patient History Summary",
    generatedAt:new Date().toISOString(),
    schemaVersion:PHS.SCHEMA_VERSION,
    period:{start:analysis.period.start, end:analysis.period.end},
    onePageSummary:{
      cc, hpi,
      keyResults,
      mainDailyPattern,
      patientQuestions:questions,
      clinicalReviewPoints:reviewPoints,
    },
    detailedReport:{
      cc, hpi,
      currentMedication,
      monitoringSummary:{
        recordedDays:analysis.period.recordedDays,
        periodDays:analysis.period.periodDays,
        totalOutputRecords:analysis.period.totalOutputRecords,
        outputAverage:o.average, outputMedian:o.median, outputMin:o.minimum, outputMax:o.maximum,
        averageDailyRange:o.averageDailyRange,
        timeOfDayAverages:o.timeOfDayAverages,
        mostStablePeriod:o.mostStablePeriod, mostVariablePeriod:o.mostVariablePeriod,
        missingMinutes:o.missingMinutes, unrecordedGapCount:o.unrecordedGaps.length,
      },
      medicationResponse:{
        morningFirstDose:m.morningFirstDose,
        allDoses:m.allDoses,
        wearingOffCandidate:m.wearingOff.candidate,
        wearingOffDays:m.wearingOff.days,
      },
      associatedSymptoms:Object.values(analysis.symptoms).map(sy=>({
        label:sy.labelKo, count:sy.count, averageOutputAtEvent:sy.averageOutputAtEvent,
        medianDurationMinutes:sy.medianDurationMinutes, relation:RELATION_KO[sy.relation]||sy.relation,
      })),
      possibleInfluencingFactors:analysis.lifestyle.associations.map(a=>T.lifestyleLine({label:a.labelKo,n:a.supportingEvents})),
      patientQuestions:questions,
      clinicalReviewPoints:reviewPoints,
      limitations,
      confidence,
    },
    graphs:{ outputCurve:true, medicationMarkers:true, symptomMarkers:true,
             lifestyleMarkers:true, estimatedMedicationEffect:true, missingIntervals:true },
    disclaimer:T.disclaimer(),
  };
  return PHS.applySafetyFilter(report);
};

})(typeof window!=="undefined"? window : globalThis);
