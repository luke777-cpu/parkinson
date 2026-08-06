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
PHS.terminologyEn = {
  delayed_response: {plain:"it takes a long time to feel better after taking medication", candidate:"possible delayed medication response"},
  incomplete_response: {plain:"medication does not bring me up to my usual best", candidate:"possible incomplete response"},
  no_clear_response: {plain:"no clear improvement after taking medication", candidate:"possible dose without a clear response (No ON Response / Dose Failure)"},
  wearing_off: {plain:"I decline before the next dose is due", candidate:"possible wearing-off pattern"},
  afternoon_decline: {plain:"my condition goes down in the afternoon", candidate:"afternoon output decline"},
  freezing: {plain:"my feet feel stuck when walking", candidate:"Freezing of Gait"},
  dyskinesia: {plain:"involuntary large movements", candidate:"Dyskinesia"},
  dystonia: {plain:"muscles pull and twist", candidate:"Dystonia"},
  tremor: {plain:"tremor", candidate:"Tremor"},
  brady: {plain:"slowness of movement", candidate:"Bradykinesia"},
  gait: {plain:"difficulty walking", candidate:"Gait difficulty"},
  fall: {plain:"near-falls or falls", candidate:"Fall risk"},
  pain: {plain:"pain", candidate:"Pain"},
  anxiety: {plain:"anxiety", candidate:"Anxiety"},
  sleep: {plain:"poor sleep", candidate:"Sleep problems"},
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
const RELATION_EN = {
  high_output_associated:"temporal association with high-output periods observed",
  low_output_associated:"temporal association with low-output periods observed",
  rising_phase_associated:"temporal association with rising output observed",
  falling_phase_associated:"temporal association with falling output observed",
  morning_associated:"temporal association with morning hours observed",
  mixed:"no consistent pattern identified",
  insufficient_data:"not enough records to assess a pattern",
};
const CONF_KO = {high:"높음", moderate:"보통", low:"낮음"};
const CONF_EN = {high:"High", moderate:"Moderate", low:"Low"};
PHS.relationText = (code,lang)=> (lang==="en"?RELATION_EN:RELATION_KO)[code]||code;
PHS.confText = (level,lang)=> (lang==="en"?CONF_EN:CONF_KO)[level]||level;

/* ---------- 신뢰도 사유 코드 → 문장 (언어별) ---------- */
const REASON_TEXTS = {
  ko: {
    days_recorded: p=>`${p.p}일 중 ${p.d}일 기록`,
    few_days: p=>`기록 일수 부족 (${p.d}일)`,
    good_daily_rate: p=>`하루 평균 ${p.n}회 출력 입력`,
    low_daily_rate: p=>`하루 평균 입력 횟수 부족 (${p.n}회)`,
    no_med_times: ()=>"복약 시각 기록 없음",
    good_dose_coverage: ()=>"복용 전후 출력 기록이 절반 이상의 복용에서 확보됨",
    low_dose_coverage: ()=>"복용 전후 출력 기록이 부족한 복용이 많음",
    frequent_gaps: p=>`${p.h}시간 이상 미기록 공백이 잦음`,
    high_retrospective: ()=>"소급 입력 비율이 높음",
    survey_agree: ()=>"설문의 체감 반응 시간과 기록 분석이 유사함",
    survey_conflict: ()=>"설문의 체감 반응 시간과 기록 분석이 일치하지 않음",
  },
  en: {
    days_recorded: p=>`Records on ${p.d} of ${p.p} days`,
    few_days: p=>`Too few recorded days (${p.d})`,
    good_daily_rate: p=>`About ${p.n} output entries per day`,
    low_daily_rate: p=>`Low daily entry rate (${p.n} per day)`,
    no_med_times: ()=>"No medication times recorded",
    good_dose_coverage: ()=>"Pre- and post-dose output available for at least half of doses",
    low_dose_coverage: ()=>"Many doses lack pre- and post-dose output records",
    frequent_gaps: p=>`Frequent unrecorded gaps longer than ${p.h} hours`,
    high_retrospective: ()=>"High proportion of retrospective entries",
    survey_conflict: ()=>"Survey-reported response time does not match the recorded analysis",
    survey_agree: ()=>"Survey-reported response time is similar to the recorded analysis",
  }
};
PHS.reasonText = (reason,lang)=>{
  if(typeof reason==="string") return reason; /* 구버전 호환 */
  const t=(REASON_TEXTS[lang==="en"?"en":"ko"]||{})[reason.code];
  return t? t(reason.params||{}) : reason.code;
};

/* 검토 발견(2026-08-06, 실사용): "단백질 많은 식사이(가) 1회(일) 기록되어..."처럼
   조사(이/가) 선택과 단위("회"인지 "일"인지)를 실제로 정하지 않고 두 후보를 괄호로
   병기한 채로 문장이 나가고 있었다("(INSUF)"라는 내부 표시가 그대로 노출된 것과
   같은 종류의 실수). 받침 유무로 조사를 고르고, 단위는 supportingEvents가 실제로는
   "건수"이므로 "회"로 통일한다. */
function hasBatchim(word){
  const ch=String(word||"").trim().slice(-1);
  const code=ch.charCodeAt(0);
  if(code<0xAC00||code>0xD7A3) return false; /* 한글 음절이 아니면 받침 없다고 간주 */
  return (code-0xAC00)%28!==0;
}
function josaIGa(word){ return hasBatchim(word)? "이":"가"; }

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
  lifestyleLine: ({label,n}) => `${label}${josaIGa(label)} ${n}회 기록되어 출력 변동과의 시간적 연관성 검토가 가능하나, 인과관계는 확정할 수 없습니다.`,
  missingDataLimitation: () => `일부 시간대는 기록이 부족하여 체류시간과 약물 반응을 정확히 평가하기 어려웠습니다.`,
  lowRecordLimitation: ({days}) => `기록 일수가 ${days}일로 적어 해석의 신뢰도가 제한적입니다.`,
  confidenceLine: ({level,score}) => `기록 데이터 신뢰도: ${CONF_KO[level]||level} (${score}/100).`,
  reviewNeeded: () => `상기 소견은 기록 기반 후보 관찰이며, 최종 판단을 위해 담당 의료진의 검토가 필요합니다.`,
  currentMedLine: ({name,dose,perDay,times}) => `${name}${dose?` ${dose}mg`:""}${times&&times.length?` — 대체로 ${times.join(", ")} 복용`:""}${perDay?` (일평균 ${perDay}회 기록)`:""}`,
  declineHours: ({hours}) => `출력이 다시 내려가기 시작하는 시각은 주로 ${hours.map(h=>`${h}시경`).join(", ")}으로 기록되었습니다.`,
  disclaimer: () => `본 Patient History Summary는 환자가 입력한 설문, 출력 기록, 약 복용 및 증상 기록을 바탕으로 자동 생성되었습니다. 본 보고서는 진단이나 약물 조정 지시를 제공하지 않으며, 최종 임상 판단은 담당 의료진이 시행해야 합니다.`,
};
PHS.templatesEn = {
  diagnosisHistory: ({years}) => years!=null? `Patient approximately ${years} years since Parkinson's disease diagnosis.` : `Patient under follow-up for Parkinson's disease.`,
  observationPurpose: () => `Output-centered records (0–100) were kept to assess daytime functional fluctuation and irregular medication response.`,
  patientComplaint: ({text}) => `The patient reports "${text}" as the main difficulty.`,
  outputRange: ({min,max,avg}) => `During the observation period, output ranged from ${min} to ${max} with an average of ${avg}.`,
  dailyRange: ({range}) => `An average within-day fluctuation of ${range} points was recorded.`,
  timePattern: ({stable,variable}) => {
    const parts=[];
    if(stable) parts.push(`output was relatively stable during ${stable}`);
    if(variable) parts.push(`fluctuation was greatest during ${variable}`);
    return parts.length? parts.join(", and ").replace(/^o/,"O")+"." : "";
  },
  delayedCandidate: ({count,minutes}) => `After the first morning dose, the median time to a meaningful output rise was ${minutes} minutes; the recorded pattern may suggest a delayed medication response on ${count} occasion(s).`,
  medianRiseOnly: ({minutes}) => `After the first morning dose, the median time to a meaningful output rise was ${minutes} minutes.`,
  incompleteCandidate: ({count}) => `On ${count} occasion(s), output rose after dosing but did not reach the usual expected level (possible incomplete response).`,
  noClearCandidate: ({count}) => `On ${count} occasion(s), no meaningful output rise was recorded despite adequate observation (possible No ON Response / Dose Failure).`,
  wearingOffCandidate: ({days}) => `A repeated decline in output before the next scheduled dose was recorded across ${days} day(s), suggesting a possible wearing-off pattern.`,
  declineHours: ({hours}) => `Output most often began to decline again around ${hours.map(h=>`${h}:00`).join(", ")}.`,
  symptomLine: ({label,count,avgOut,relation,dur}) => {
    let s=`${label} recorded ${count} time(s)`;
    if(avgOut!=null) s+=` (average output at onset ${avgOut}`;
    if(dur!=null) s+= avgOut!=null? `, median duration ${dur} min)` : ` (median duration ${dur} min)`;
    else if(avgOut!=null) s+=`)`;
    if(relation) s+=` — ${relation}`;
    return s+".";
  },
  lifestyleLine: ({label,n}) => `${label} was recorded ${n} time(s); a temporal association with output change can be reviewed, but causation cannot be established.`,
  missingDataLimitation: () => `Some periods lack records, limiting accurate assessment of dwell time and medication response.`,
  lowRecordLimitation: ({days}) => `Only ${days} recorded day(s); interpretation reliability is limited.`,
  confidenceLine: ({level,score}) => `Recorded-data confidence: ${CONF_EN[level]||level} (${score}/100).`,
  reviewNeeded: () => `These are record-based candidate observations; final judgment requires review by the treating clinician.`,
  currentMedLine: ({name,dose,perDay,times}) => `${name}${dose?` ${dose}mg`:""}${times&&times.length?` — usually taken at ${times.join(", ")}`:""}${perDay?` (avg ${perDay} record(s)/day)`:""}`,
  disclaimer: () => `This Patient History Summary was generated automatically from the user's surveys, output records, medication and symptom logs. It is based on information entered by the user and is intended to support communication with healthcare professionals. It is not a medical diagnosis and does not provide medication adjustment instructions; final clinical judgment must be made by the treating clinician.`,
};

/* ---------- 영어 안전 필터 ---------- */
PHS.SAFETY_RULES_EN = [
  {re:/\bhas\s+Delayed\s*ON\b/gi, to:"has records that may suggest a delayed medication response"},
  {re:/\bis\s+Delayed\s*ON\b/gi, to:"may suggest a delayed medication response"},
  {re:/\bhas\s+ON\s*failure\b/gi, to:"has doses without a clear recorded response"},
  {re:/\bdiagnos(ed|is)\b/gi, to:"record-based observation"},
  {re:/\bmust\s+(increase|decrease|change)\b[^.]*/gi, to:"requires review by the treating clinician"},
  {re:/\bis\s+caused\s+by\b/gi, to:"shows a temporal association (causation cannot be established) with"},
];
PHS.PROHIBITED_PATTERNS_EN = [/\bhas Delayed ON\b/i, /\bhas ON failure\b/i, /\bdiagnosed\b/i, /\bmust (increase|decrease)\b/i, /\bis caused by\b/i];

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
  (PHS.SAFETY_RULES_EN||[]).forEach(r=>{ out=out.replace(r.re, r.to); });
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
    if(typeof n==="string"){ PHS.PROHIBITED_PATTERNS.concat(PHS.PROHIBITED_PATTERNS_EN||[]).forEach(p=>{ if(p.test(n)) bad.push({path, pattern:String(p), text:n}); }); }
    else if(Array.isArray(n)) n.forEach((v,i)=>walk(v,`${path}[${i}]`));
    else if(n&&typeof n==="object") Object.entries(n).forEach(([k,v])=>walk(v,`${path}.${k}`));
  })(reportJson,"report");
  return bad;
};

/* ---------- 문제 코드 → 한국어 라벨 ---------- */
PHS.problemLabel = function(code,lang){
  const t=(lang==="en"? PHS.terminologyEn : PHS.terminologyKo)[code];
  return t? t.candidate : code;
};
PHS.problemLabelKo = code=>PHS.problemLabel(code,"ko"); /* 구버전 호환 */

/* ---------- CC 생성 (§10: primary + 최대 2개 secondary) ---------- */
function buildCC(startSurvey,lang){
  const fallback = lang==="en"? "Assessment of output fluctuation and medication response" : "출력 변동 및 약물 반응 평가";
  if(!startSurvey) return fallback;
  const primary=startSurvey.primaryProblem||null;
  const secondary=(startSurvey.chiefProblems||[]).filter(c=>c!==primary).slice(0,2);
  const parts=[primary, ...secondary].filter(Boolean).map(c=>PHS.problemLabel(c,lang));
  return parts.length? parts.join(", ") : fallback;
}

/* ---------- HPI 생성 (§11 고정 순서) ---------- */
function buildHPI({profile, startSurvey, analysis, confidence, lang}, T){
  const s=[];
  s.push(T.diagnosisHistory({years:profile&&profile.diagnosisYears!=null? profile.diagnosisYears : null})); //1 진단 경과
  s.push(T.observationPurpose()); //2 관찰 목적
  if(startSurvey&&startSurvey.primaryProblem){ //3 환자 보고 주호소
    const term=(lang==="en"? PHS.terminologyEn : PHS.terminologyKo)[startSurvey.primaryProblem];
    s.push(T.patientComplaint({text:(term&&term.plain)||startSurvey.primaryProblem}));
  }
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
  if(analysis.medicationResponse.wearingOff.candidate){
    s.push(T.wearingOffCandidate({days:analysis.medicationResponse.wearingOff.days}));
    const rh=analysis.medicationResponse.wearingOff.recurrentHours; //6b 다시 나빠지는 시각 (v0.9.20)
    if(rh&&rh.length) s.push(T.declineHours({hours:rh}));
  }
  Object.values(analysis.symptoms).forEach(sy=>{ //7 동반 증상
    if(sy.count>=2) s.push(T.symptomLine({label:PHS.symptomLabel(sy.key,lang),count:sy.count,avgOut:sy.averageOutputAtEvent,relation:PHS.relationText(sy.relation,lang),dur:sy.medianDurationMinutes}));
  });
  analysis.lifestyle.associations.slice(0,2).forEach(a=>{ //8 생활 연관성
    s.push(T.lifestyleLine({label:lifestyleLabel(a,lang),n:a.supportingEvents}));
  });
  //9 자료 한계
  if(analysis.output.missingMinutes>0) s.push(T.missingDataLimitation());
  if(analysis.period.recordedDays<3) s.push(T.lowRecordLimitation({days:analysis.period.recordedDays}));
  return s.filter(Boolean).join(" ");
}

const LIFESTYLE_LABELS={high_protein_meal:{ko:"단백질 많은 식사",en:"High-protein meals"},late_meal:{ko:"늦은 시간 식사",en:"Late meals"},poor_sleep:{ko:"수면의 질 저하",en:"Poor sleep quality"},constipation:{ko:"변비 의심 배변",en:"Possible constipation"}};
function lifestyleLabel(a,lang){ const l=LIFESTYLE_LABELS[a.factor]; return l? l[lang==="en"?"en":"ko"] : a.labelKo; }

/* ---------- 임상 검토 포인트 ---------- */
function buildReviewPoints(analysis, startSurvey, lang){
  const pts=[]; const en=lang==="en";
  const m=analysis.medicationResponse.morningFirstDose;
  const needs=en?" — review by the treating clinician is needed.":" — 담당 의료진의 검토가 필요합니다.";
  if(m.delayedCandidates>0) pts.push((en?`Possible delayed response after the first morning dose, ${m.delayedCandidates} time(s)`:`오전 첫 복용 후 반응 지연 후보 ${m.delayedCandidates}회`)+needs);
  if(m.incompleteCandidates>0) pts.push((en?`Records suggesting incomplete output recovery, ${m.incompleteCandidates} time(s)`:`불완전한 출력 회복이 의심되는 기록 ${m.incompleteCandidates}회`)+needs);
  if(m.noClearResponseCandidates>0) pts.push((en?`Doses without a clear recorded response (possible No ON Response), ${m.noClearResponseCandidates} time(s)`:`뚜렷한 반응이 확인되지 않은 후보 ${m.noClearResponseCandidates}회`)+needs);
  if(analysis.medicationResponse.wearingOff.candidate) pts.push(en?`Repeated pre-dose output decline — review of a possible wearing-off pattern is needed.`:`다음 복용 전 출력 하강의 반복 기록 — 웨어링오프 의심 패턴에 대한 검토가 필요합니다.`);
  Object.values(analysis.symptoms).forEach(sy=>{
    if(sy.count>=2 && (sy.relation==="high_output_associated"||sy.relation==="low_output_associated"))
      pts.push(en? `${PHS.symptomLabel(sy.key,lang)}: ${PHS.relationText(sy.relation,lang)} — causation cannot be established; review is needed.`
                 : `${PHS.symptomLabel(sy.key,lang)}의 ${PHS.relationText(sy.relation,lang)} — 인과관계는 확정할 수 없으며 검토가 필요합니다.`);
  });
  if(!pts.length) pts.push(en?"No clear repeated pattern candidates were identified in the records. Comprehensive review by the treating clinician is needed.":"기록상 뚜렷한 반복 패턴 후보는 확인되지 않았습니다. 담당 의료진의 종합 검토가 필요합니다.");
  return pts;
}

/* ---------- 환자 질문 (§12 순서: 자유 질문 → 선택 질문 → 제안 질문[별도 표기]) ---------- */
PHS.QUESTION_PRESETS={
  q_delay_reason:{ko:"약 반응이 늦어지는 이유가 궁금합니다.",en:"I would like to understand why my medication response is delayed."},
  q_timing:{ko:"복용 시간 조정이 필요한지 여쭙고 싶습니다.",en:"I would like to ask whether my dose timing needs adjustment."},
  q_afternoon:{ko:"오후에 나빠지는 것에 대해 여쭙고 싶습니다.",en:"I would like to ask about getting worse in the afternoon."},
  q_dyskinesia:{ko:"이상운동(몸이 저절로 흔들림)에 대해 여쭙고 싶습니다.",en:"I would like to ask about dyskinesia (involuntary movements)."},
  q_method:{ko:"지금 기록 방법이 적절한지 확인받고 싶습니다.",en:"I would like to confirm whether my current recording method is appropriate."},
};
function presetText(code,lang){ const p=PHS.QUESTION_PRESETS[code]; return p? p[lang==="en"?"en":"ko"] : code; }
function buildQuestions(startSurvey, endSurvey, analysis, lang){
  const qs=[]; const en=lang==="en";
  if(startSurvey&&startSurvey.freeQuestion) qs.push({type:"free", text:startSurvey.freeQuestion}); // 환자 입력 원문 보존 (자동 번역 금지)
  (startSurvey&&startSurvey.selectedPatientQuestions||[]).forEach(q=>qs.push({type:"selected", text:presetText(q,lang)}));
  if(endSurvey&&endSurvey.additionalClinicianQuestion) qs.push({type:"free", text:endSurvey.additionalClinicianQuestion});
  /* 반복 패턴 기반 제안 질문 — 별도 라벨, 지시 아님 */
  const m=analysis.medicationResponse.morningFirstDose;
  if(m.delayedCandidates>=2) qs.push({type:"suggested", text:en?"My records repeatedly show a slow response after the first morning dose — I would like to ask how you see this.":"오전 첫 복용 후 반응이 늦어지는 기록이 반복되는데, 이에 대해 어떻게 보시는지 여쭙고 싶습니다."});
  if(analysis.medicationResponse.wearingOff.candidate) qs.push({type:"suggested", text:en?"My records repeatedly show decline before the next dose is due — I would like to ask for your review.":"다음 약 시간 전에 몸이 먼저 가라앉는 기록이 반복되는데, 검토를 부탁드리고 싶습니다."});
  return qs;
}

/* ---------- 보고서 엔진 (총괄) ---------- */
/* v0.9.21: Medication Challenge 결과 → PHS "Medication Response Tests" 항목 (코드값 → ko/en 라벨) */
const CHG_LBL={
  role:{ baseline:{ko:"기준 시험",en:"Baseline test"}, changed:{ko:"변경 후 시험",en:"Post-change test"}, standalone:{ko:"단독 시험",en:"Standalone test"} },
  testType:{ current_regimen:{ko:"현재 복용약 반응 확인",en:"Current regimen response"}, dose_changed:{ko:"용량 변경 후 반응 확인",en:"Response after dose change"},
    medication_added:{ko:"약 추가 후 반응 확인",en:"Response after adding a medication"}, regimen_changed:{ko:"약 조합 변경 후 반응 확인",en:"Response after regimen change"},
    time_changed:{ko:"복용 시간 변경 후 반응 확인",en:"Response after timing change"}, other:{ko:"기타",en:"Other"} },
  overall:{ marked_effect:{ko:"효과가 뚜렷했다",en:"Marked effect"}, moderate_effect:{ko:"어느 정도 효과가 있었다",en:"Moderate effect"},
    small_effect:{ko:"효과가 적었다",en:"Small effect"}, no_effect:{ko:"효과가 없었다",en:"No effect"},
    worse:{ko:"오히려 더 불편해졌다",en:"Felt worse"}, uncertain:{ko:"판단하기 어렵다",en:"Hard to judge"} },
  adverse:{ dyskinesia:{ko:"이상운동증",en:"Dyskinesia"}, dizziness:{ko:"어지럼",en:"Dizziness"}, drowsiness:{ko:"졸림",en:"Drowsiness"},
    nausea:{ko:"메스꺼움",en:"Nausea"}, headache:{ko:"두통",en:"Headache"}, palpitation:{ko:"두근거림",en:"Palpitations"},
    low_bp:{ko:"혈압 저하 느낌",en:"Feeling of low blood pressure"}, anxiety:{ko:"불안·초조",en:"Anxiety/agitation"},
    hallucination:{ko:"환시",en:"Visual hallucinations"}, confusion:{ko:"혼란",en:"Confusion"}, other:{ko:"기타",en:"Other"} },
  group:{ motor:{ko:"운동",en:"motor"}, nonmotor:{ko:"비운동",en:"non-motor"}, autonomic:{ko:"자율신경",en:"autonomic"} },
};
function chgLbl(cat,code,lang){ const e=(CHG_LBL[cat]||{})[code]; return e? (lang==="en"?e.en:e.ko) : (code||""); }
function buildChallengeSection(tests, lang){
  const en=lang==="en";
  const title=en? "Medication Response Tests (patient-run comparison)":"약효 반응 시험 (환자 자가 비교 기록)";
  const note=en? "Patient-recorded structured response tests (pre-dose and 30/60/90/120 min). Summary of recorded facts only; not a levodopa challenge test result or treatment judgment."
              : "환자가 복용 전과 30·60·90·120분 시점에 직접 기록한 구조화 시험 요약입니다. 기록 사실의 정리이며, 레보도파 반응 판정이나 치료 판단이 아닙니다.";
  if(!tests||!tests.length) return {title, note, lines:[en? "No completed tests":"완료된 시험 없음"]};
  const NA=en? "N/A":"평가 불가";
  const lines=tests.slice(-3).reverse().map(t=>{
    const parts=[];
    parts.push(`${t.date||""} · ${chgLbl("testType",t.typeCode,lang)} · ${chgLbl("role",t.roleCode,lang)} · ${t.title||""}`.trim());
    parts.push(en? `First perceived effect: ${t.firstPerceivedMin!=null? t.firstPerceivedMin+" min":NA} / clear effect: ${t.firstClearMin!=null? t.firstClearMin+" min":NA}`
                 : `최초 체감 ${t.firstPerceivedMin!=null? t.firstPerceivedMin+"분":NA} / 분명한 체감 ${t.firstClearMin!=null? t.firstClearMin+"분":NA}`);
    const imps=Object.entries(t.maxImpByGroup||{}).filter(([,v])=>v!=null);
    parts.push(imps.length? (en? "Max score decrease: ":"최대 점수 감소: ")+imps.map(([g,v])=>`${chgLbl("group",g,lang)} ${v}`).join(", ")
                          : (en? "Max score decrease: not enough data":"최대 점수 감소: 기록 부족"));
    parts.push(t.worstAdverse? (en? `Max adverse: ${chgLbl("adverse",t.worstAdverse.code,lang)} ${t.worstAdverse.score}/4 at ${t.worstAdverse.minutes} min`
                                  : `부작용 최고: ${chgLbl("adverse",t.worstAdverse.code,lang)} ${t.worstAdverse.score}/4 (${t.worstAdverse.minutes}분)`)
                             : (en? "Max adverse: none recorded":"부작용 최고: 기록 없음"));
    parts.push((en? "Patient overall: ":"환자 종합평가: ")+(t.overallCode? chgLbl("overall",t.overallCode,lang):NA));
    return parts.join("\n  ");
  });
  return {title, note, lines};
}
PHS.buildChallengeSection = buildChallengeSection;

/* v2.5(치료구간 설계도 Phase 4): 부족 구간을 채우는 후보안 비교.
   comparison: analysis-candidates.js의 CAND.evaluate() 결과.
   window: {lower, upper} — Phase 2에서 추정한 치료 구간.
   이 섹션은 detailedReport(의료진용)에만 들어간다 — 환자 화면(오늘/분석 탭)에는 절대 안 보인다.
   "추천"·"1위" 표현을 쓰지 않고, 정렬 기준(체류시간 증가량)을 매 줄 함께 밝힌다. */
function buildTherapeuticWindowSection(comparison, window, lang){
  const en=lang==="en";
  const title=en? "Therapeutic Window — Deficit Candidate Comparison" : "치료 구간 — 부족분 채우기 후보안 비교";
  const note=en? "Simulated comparison only, based on the estimated therapeutic window and effect-estimate curve. Not a prescription recommendation. Candidates are ranked by estimated time-within-window gain, not by how much of the deficit each fills — filling a deficit can overshoot the upper bound. Verify with a medication response test before any change."
              : "추정된 치료 구간과 약효 추정곡선을 비교한 시뮬레이션 결과입니다. 처방 권고가 아닙니다. 후보는 부족분을 얼마나 채우는지가 아니라 '구간 내 체류시간이 얼마나 느는지'로 정렬했습니다 — 부족분을 채우면 상한을 넘길 수 있습니다. 실제 적용 전 약효 반응 시험으로 확인하세요.";
  if(!comparison || !comparison.valid){
    const reason=(comparison&&comparison.reasons&&comparison.reasons[0]) || (en?"Not enough data":"자료 부족");
    return {title, note, lines:[en? `Not calculated (${reason})` : `계산되지 않음 (${reason})`]};
  }
  const fmtH=(min)=>{ min=Math.round(min); const h=Math.floor(Math.abs(min)/60), m=Math.abs(min)%60;
    const sign=min<0?"-":"+"; return `${sign}${h}${en?"h":"시간"}${m}${en?"m":"분"}`; };
  const winLine=en? `Estimated window: ${Math.round(window.lower*100)/100} ~ ${window.upper!=null?Math.round(window.upper*100)/100:"N/A"}`
                   : `추정 구간: ${Math.round(window.lower*100)/100} ~ ${window.upper!=null?Math.round(window.upper*100)/100:"판정 불가"}`;
  const baseLine=en? `Baseline time within window: ${Math.round(comparison.baseline.inWindowMin/60*10)/10}h`
                    : `현재안 구간 내 체류시간: ${Math.round(comparison.baseline.inWindowMin/60*10)/10}시간`;
  const lines=[winLine, baseLine];
  if(!comparison.candidates.length){
    lines.push(en? "No candidates could be generated from the current regimen (unregistered drugs, or no applicable pattern)."
                  : "현재 복약 구성으로는 만들 수 있는 후보안이 없습니다(미등록 약이거나 해당 유형이 없음).");
  }
  comparison.candidates.forEach(c=>{
    if(!c.valid){ lines.push(`${c.label} — ${en?"could not be calculated":"계산할 수 없음"}`); return; }
    const warn=c.crossesUpper? (en?" ⚠ increases time above upper bound":" ⚠ 상한 초과 시간이 늘어남") : "";
    lines.push(`${c.label} — ${en?"time within window":"구간 내 체류시간"} ${fmtH(c.deltaMin)}${warn}`);
  });
  return {title, note, lines};
}
PHS.buildTherapeuticWindowSection = buildTherapeuticWindowSection;

/* v2.6(치료구간 설계도 Phase 5): 과거 보고서에서 제안했던 후보안을 실제로 복용한 뒤의
   결과와, 그때의 예측을 비교한다. 이 섹션도 detailedReport(의료진용)에만 들어간다 —
   환자 화면(오늘/분석 탭)에는 어떤 형태로도 노출하지 않는다.
   validation: {results:[{label,predictedDeltaMin,actualDeltaMin,errorMin,direction,
   baselineDayKey,appliedDayKey}], pendingCount} — index.html의 anGatherValidationResults()가 만든다. */
function buildValidationSection(validation, lang){
  const en=lang==="en";
  const title=en? "Prediction vs Actual (Applied Candidates)" : "예측 vs 실제 (적용된 후보안)";
  const note=en? "Compares a candidate suggested in a past report against records from a day it was actually taken. A mismatch is not a failure — the difference is used to refine future estimates. Not a treatment judgment."
              : "과거 보고서에서 제안했던 후보안을 실제로 복용한 날의 기록과, 그때 예측했던 값을 비교합니다. 예측과 다르다고 잘못된 것이 아니며, 그 차이가 다음 추정을 더 정확하게 만드는 데 쓰입니다. 치료 판단이 아닙니다.";
  if(!validation || (!validation.results.length && !validation.pendingCount)){
    return {title, note, lines:[en? "No applied candidates to compare yet." : "아직 실제로 적용해 비교할 수 있는 후보안이 없습니다."]};
  }
  const DIR=en? {close:"close to prediction", exceeded:"better than predicted", fell_short:"below prediction"}
              : {close:"예측과 비슷함", exceeded:"예측보다 좋았음", fell_short:"예측에 못 미침"};
  const fmtH=(min)=>{ const sign=min<0?"-":"+"; min=Math.round(Math.abs(min));
    return `${sign}${Math.floor(min/60)}${en?"h":"시간"} ${min%60}${en?"m":"분"}`; };
  const lines=(validation.results||[]).map(r=>
    `${r.label} (${r.baselineDayKey}→${r.appliedDayKey}) — ${en?"predicted":"예측"} ${fmtH(r.predictedDeltaMin)} / ${en?"actual":"실제"} ${fmtH(r.actualDeltaMin)} · ${DIR[r.direction]}`);
  if(validation.pendingCount) lines.push(en? `${validation.pendingCount} more suggested candidate(s) not yet observed in the records.`
                                            : `아직 기록에서 확인되지 않은 후보안이 ${validation.pendingCount}건 더 있습니다.`);
  return {title, note, lines};
}
PHS.buildValidationSection = buildValidationSection;

PHS.buildReport = function({profile, startSurvey, endSurvey, analysis, confidence, medsList, lang, challengeTests, therapeuticWindow, validation}){
  lang = lang==="en"? "en":"ko";
  const T = lang==="en"? PHS.templatesEn : PHS.templatesKo;
  const cc=buildCC(startSurvey,lang);
  const hpi=buildHPI({profile,startSurvey,analysis,confidence,lang}, T);
  const m=analysis.medicationResponse, o=analysis.output;
  const keyResults=[];
  if(o.average!=null) keyResults.push(T.outputRange({min:o.minimum,max:o.maximum,avg:o.average}));
  if(m.morningFirstDose.medianRiseMinutes!=null) keyResults.push(T.medianRiseOnly({minutes:m.morningFirstDose.medianRiseMinutes}));
  const symTop=Object.values(analysis.symptoms).sort((a,b)=>b.count-a.count)[0];
  if(symTop&&symTop.count>0) keyResults.push(T.symptomLine({label:PHS.symptomLabel(symTop.key,lang),count:symTop.count,avgOut:symTop.averageOutputAtEvent,relation:PHS.relationText(symTop.relation,lang),dur:symTop.medianDurationMinutes}));
  keyResults.push(T.confidenceLine({level:confidence.overall,score:confidence.score}));
  const mainDailyPattern = (()=>{
    const parts=[];
    const tp=T.timePattern({stable:o.mostStablePeriod,variable:o.mostVariablePeriod});
    if(tp) parts.push(tp);
    if(m.wearingOff.candidate) parts.push(T.wearingOffCandidate({days:m.wearingOff.days}));
    if(m.wearingOff.candidate && m.wearingOff.recurrentHours.length) parts.push(T.declineHours({hours:m.wearingOff.recurrentHours}));
    return parts.join(" ") || (lang==="en"? "Not enough records to assess time-of-day patterns." : "시간대별 패턴을 평가하기에 기록이 충분하지 않습니다.");
  })();
  const questions=buildQuestions(startSurvey,endSurvey,analysis,lang);
  const reviewPoints=buildReviewPoints(analysis,startSurvey,lang);
  /* 현재 약물: 관찰기간 복약 기록 기준 (등록된 약 목록 참조) */
  const doseDays={};
  analysis._adapted.medicationEvents.forEach(me=>{
    const k=me.name; (doseDays[k]||(doseDays[k]={n:0})).n++;
  });
  const days=Math.max(1,analysis.period.recordedDays);
  const currentMedication=(analysis.medicationResponse.doseSchedule||[]).map(ds=>
    T.currentMedLine({name:ds.name, dose:ds.doseMg, times:ds.times,
                      perDay:((doseDays[ds.name]||{n:0}).n/days).toFixed(1)}));
  const limitations=[];
  if(o.missingMinutes>0) limitations.push(T.missingDataLimitation());
  if(analysis.period.recordedDays<3) limitations.push(T.lowRecordLimitation({days:analysis.period.recordedDays}));
  confidence.reasons.forEach(rr=>limitations.push(PHS.reasonText(rr,lang)));
  const report={
    title:"Patient History Summary",
    lang,
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
      medicationResponseTests:buildChallengeSection(challengeTests, lang==="en"?"en":"ko"),
      /* v2.5 Phase 4: therapeuticWindow가 있을 때만(선택적) 후보안 비교 섹션 삽입 — 없으면 생략(하위 호환) */
      therapeuticWindowAnalysis: therapeuticWindow? buildTherapeuticWindowSection(therapeuticWindow.comparison, therapeuticWindow.window, lang==="en"?"en":"ko") : null,
      /* v2.6 Phase 5: validation이 있을 때만(선택적) 예측 검증 섹션 삽입 — 없으면 생략(하위 호환) */
      predictionValidation: validation? buildValidationSection(validation, lang==="en"?"en":"ko") : null,
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
        key:sy.key, label:PHS.symptomLabel(sy.key,lang), count:sy.count, averageOutputAtEvent:sy.averageOutputAtEvent,
        medianDurationMinutes:sy.medianDurationMinutes, relation:PHS.relationText(sy.relation,lang),
      })),
      possibleInfluencingFactors:analysis.lifestyle.associations.map(a=>T.lifestyleLine({label:lifestyleLabel(a,lang),n:a.supportingEvents})),
      patientQuestions:questions,
      clinicalReviewPoints:reviewPoints,
      limitations,
      confidence:{...confidence, reasonsText:confidence.reasons.map(rr=>PHS.reasonText(rr,lang))},
    },
    graphs:{ outputCurve:true, medicationMarkers:true, symptomMarkers:true,
             lifestyleMarkers:true, estimatedMedicationEffect:true, missingIntervals:true },
    disclaimer:T.disclaimer(),
  };
  return PHS.applySafetyFilter(report);
};

})(typeof window!=="undefined"? window : globalThis);
