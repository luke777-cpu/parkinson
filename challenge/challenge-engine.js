/* ============================================================
   약효 비교 테스트 — 독립 엔진 (challenge-engine.js)
   WORK_ORDER_MEDICATION_RESPONSE_CHALLENGE_v1 기반.
   기존 약효일지와 완전 분리: 자체 저장 키, 본체 코드 의존 없음.
   순수 계산만 담당 — DOM/네트워크 접근 없음.
   ============================================================ */
(function(root){
"use strict";
const CHG = {};

CHG.STORAGE_KEY = "medicationChallengeDbV1";
CHG.SCHEMA_VERSION = 1;

/* ---------- 코드 사전 (언어 중립 저장, 표시 시 번역) ---------- */
CHG.TEST_TYPES = [
  {code:"current_regimen", ko:"현재 약의 반응 확인", en:"Check current medication response"},
  {code:"dose_changed",    ko:"용량 변경 후 반응 확인", en:"After a dose change"},
  {code:"medication_added",ko:"약 추가 후 반응 확인", en:"After a medication was added"},
  {code:"regimen_changed", ko:"약 조합 또는 복용 시간 변경 후 확인", en:"After a regimen/timing change"},
  {code:"other",           ko:"기타", en:"Other"},
];
CHG.SYMPTOMS = [
  {code:"hand_movement",  ko:"손동작 또는 손가락 움직임", en:"Hand/finger movement"},
  {code:"tremor",         ko:"떨림", en:"Tremor"},
  {code:"rigidity",       ko:"뻣뻣함", en:"Rigidity"},
  {code:"gait_start",     ko:"걷기 시작", en:"Gait initiation"},
  {code:"foot_dragging",  ko:"발 끌림", en:"Foot dragging"},
  {code:"freezing_of_gait",ko:"동결보행", en:"Freezing of gait"},
  {code:"dystonia",       ko:"발가락 말림 또는 근긴장이상", en:"Toe curling / dystonia"},
  {code:"speech",         ko:"말하기 또는 목소리", en:"Speech / voice"},
  {code:"overall_mobility",ko:"전반적인 움직임", en:"Overall mobility"},
  {code:"custom",         ko:"기타 직접 입력", en:"Other (type in)"},
];
CHG.SCORE_RUBRIC = [
  {v:0, ko:"증상 없음"},
  {v:1, ko:"약간 있으나 거의 불편하지 않음"},
  {v:2, ko:"분명히 있으나 활동 가능"},
  {v:3, ko:"활동에 상당한 지장"},
  {v:4, ko:"매우 심하거나 해당 활동이 어려움"},
];
CHG.STAGES = [
  {stage:"baseline", minutes:0,   ko:"복용 전"},
  {stage:"m30",      minutes:30,  ko:"복용 30분 후"},
  {stage:"m60",      minutes:60,  ko:"복용 60분 후"},
  {stage:"m90",      minutes:90,  ko:"복용 90분 후"},
  {stage:"m120",     minutes:120, ko:"복용 120분 후"},
];
CHG.PERCEIVED = [
  {code:"uncertain", ko:"아직 모르겠다"},
  {code:"slight",    ko:"조금 느껴진다"},
  {code:"clear",     ko:"분명히 느껴진다"},
  {code:"worse",     ko:"오히려 더 불편하다"},
];
CHG.ADVERSE = [
  {code:"none",        ko:"없음"},
  {code:"dyskinesia",  ko:"이상운동증"},
  {code:"dizziness",   ko:"어지럼"},
  {code:"drowsiness",  ko:"졸림"},
  {code:"nausea",      ko:"메스꺼움"},
  {code:"headache",    ko:"두통"},
  {code:"palpitation", ko:"두근거림"},
  {code:"low_bp",      ko:"혈압 저하 느낌"},
  {code:"anxiety",     ko:"불안 또는 초조"},
  {code:"hallucination",ko:"환시 또는 혼란"},
  {code:"other",       ko:"기타"},
];
CHG.AE_SEVERITY = [
  {code:"mild",     ko:"가벼움"},
  {code:"moderate", ko:"중간"},
  {code:"severe",   ko:"심함"},
];
CHG.OVERALL = [
  {code:"marked_effect",   ko:"효과가 뚜렷했다"},
  {code:"moderate_effect", ko:"어느 정도 효과가 있었다"},
  {code:"small_effect",    ko:"효과가 적었다"},
  {code:"no_effect",       ko:"효과가 없었다"},
  {code:"worse",           ko:"오히려 더 불편해졌다"},
  {code:"uncertain",       ko:"판단하기 어렵다"},
];
CHG.AE_SUMMARY = [
  {code:"none",              ko:"없음"},
  {code:"tolerable",         ko:"있었으나 감당 가능"},
  {code:"worse_than_benefit",ko:"효과보다 부작용이 더 문제"},
  {code:"uncertain",         ko:"판단하기 어려움"},
];
const dict = list => Object.fromEntries(list.map(x=>[x.code!==undefined?x.code:x.stage, x.ko]));
CHG.ko = {
  testType: dict(CHG.TEST_TYPES), symptom: dict(CHG.SYMPTOMS), stage: dict(CHG.STAGES),
  perceived: dict(CHG.PERCEIVED), adverse: dict(CHG.ADVERSE), severity: dict(CHG.AE_SEVERITY),
  overall: dict(CHG.OVERALL), aeSummary: dict(CHG.AE_SUMMARY),
};
CHG.label = (group, code) => (CHG.ko[group]||{})[code] || code || "";
CHG.symptomLabel = (test, code) => {
  if(code==="custom"){
    const sy=(test.symptoms||[]).find(s=>s.code==="custom");
    return (sy && sy.customLabel) || CHG.label("symptom","custom");
  }
  return CHG.label("symptom", code);
};

/* ---------- 빈 DB / 테스트 골격 ---------- */
CHG.emptyDb = () => ({version:CHG.SCHEMA_VERSION, tests:[], settings:{language:"ko"}});
CHG.newTest = ({testType, title, medication, symptoms}) => ({
  id: "challenge_"+Date.now().toString(36)+Math.random().toString(36).slice(2,6),
  createdAt: new Date().toISOString(),
  status: "in_progress",
  testType: testType||"current_regimen",
  title: title||"",
  medication: {
    name: medication.name||"", dose: medication.dose||"", dosageForm: medication.dosageForm||"",
    scheduledTime: medication.scheduledTime||"", doseTakenAt: medication.doseTakenAt||null,
    additionalMedications: medication.additionalMedications||[],
    changeDescription: medication.changeDescription||"",
  },
  symptoms: symptoms||[],       // [{code, customLabel}]
  assessments: [],              // [{stage, scheduledMinutes, actualMinutes, recordedAt, symptomScores, perceivedEffect, adverseEffects:[{code,severity}], note}]
  finalEvaluation: null,        // {overallEffect, adverseEffectSummary, note}
});

/* ---------- 분석 (단순·설명 가능 계산만) ---------- */
function avg(nums){ const v=nums.filter(n=>typeof n==="number"&&isFinite(n)); return v.length? Math.round(v.reduce((a,b)=>a+b,0)/v.length*10)/10 : null; }

CHG.analyzeTest = function(test){
  const stages = CHG.STAGES.map(st=>{
    const a=(test.assessments||[]).find(x=>x.stage===st.stage);
    if(!a) return {stage:st.stage, minutes:st.minutes, recorded:false, avgScore:null, delta:null, perceivedEffect:null, adverseEffects:[]};
    const scores=Object.values(a.symptomScores||{});
    return {stage:st.stage, minutes:st.minutes, recorded:true,
      actualMinutes: a.actualMinutes!=null? a.actualMinutes : st.minutes,
      avgScore: avg(scores), perceivedEffect: a.perceivedEffect||null,
      adverseEffects: (a.adverseEffects||[]).filter(x=>x.code!=="none"), note:a.note||""};
  });
  const base = stages.find(s=>s.stage==="baseline");
  const baseScore = base && base.recorded? base.avgScore : null;
  stages.forEach(s=>{ s.delta = (baseScore!=null && s.avgScore!=null && s.stage!=="baseline")? Math.round((baseScore-s.avgScore)*10)/10 : null; });
  const recordedPost = stages.filter(s=>s.recorded && s.stage!=="baseline" && s.avgScore!=null);
  const minScore = recordedPost.length? Math.min(...recordedPost.map(s=>s.avgScore)) : null;
  const bestStage = recordedPost.length? recordedPost.reduce((b,s)=> s.avgScore<b.avgScore? s:b) : null;
  const maxImprovement = (baseScore!=null && bestStage)? Math.round((baseScore-bestStage.avgScore)*10)/10 : null;
  const firstPerceived = stages.find(s=>s.recorded && (s.perceivedEffect==="slight"||s.perceivedEffect==="clear")) || null;
  const firstClear = stages.find(s=>s.recorded && s.perceivedEffect==="clear") || null;
  const firstAdverse = stages.find(s=>s.recorded && s.adverseEffects.length>0) || null;
  const worstAe = (()=>{ // 가장 심한 부작용 1건 (표시용)
    const order={mild:1,moderate:2,severe:3}; let w=null;
    stages.forEach(s=>s.adverseEffects.forEach(ae=>{ if(!w || (order[ae.severity]||0)>(order[w.severity]||0)) w=ae; }));
    return w;
  })();
  return {
    testId: test.id, title: test.title, medication: test.medication, testType: test.testType,
    baselineScore: baseScore, stages,
    minPostScore: minScore, bestStage: bestStage? {stage:bestStage.stage, minutes:bestStage.minutes, avgScore:bestStage.avgScore}:null,
    maxImprovement,
    firstPerceivedStage: firstPerceived? {stage:firstPerceived.stage, minutes:firstPerceived.minutes}:null,
    firstClearStage: firstClear? {stage:firstClear.stage, minutes:firstClear.minutes}:null,
    firstAdverseStage: firstAdverse? {stage:firstAdverse.stage, minutes:firstAdverse.minutes}:null,
    worstAdverse: worstAe,
    finalEvaluation: test.finalEvaluation||null,
    recordedStageCount: stages.filter(s=>s.recorded).length,
  };
};

/* ---------- 두 시험 비교 (판정 없음 — 기술적 서술만) ---------- */
CHG.compareTests = function(baseTest, afterTest){
  const A=CHG.analyzeTest(baseTest), B=CHG.analyzeTest(afterTest);
  const rows=[
    {key:"baselineScore",  ko:"복용 전 평균 점수", a:A.baselineScore, b:B.baselineScore, fmt:v=>v==null?"기록 부족":v},
    {key:"firstPerceived", ko:"최초 체감 시점", a:A.firstPerceivedStage&&A.firstPerceivedStage.minutes, b:B.firstPerceivedStage&&B.firstPerceivedStage.minutes, fmt:v=>v==null?"기록 없음":v+"분"},
    {key:"bestStage",      ko:"가장 좋은 시점", a:A.bestStage&&A.bestStage.minutes, b:B.bestStage&&B.bestStage.minutes, fmt:v=>v==null?"기록 부족":v+"분"},
    {key:"maxImprovement", ko:"최대 개선 정도", a:A.maxImprovement, b:B.maxImprovement, fmt:v=>v==null?"기록 부족":v+"점"},
    {key:"m120",           ko:"120분 시점 평균 점수", a:(A.stages.find(s=>s.stage==="m120")||{}).avgScore, b:(B.stages.find(s=>s.stage==="m120")||{}).avgScore, fmt:v=>v==null?"기록 없음":v},
    {key:"overall",        ko:"사용자 종합평가", a:A.finalEvaluation&&A.finalEvaluation.overallEffect, b:B.finalEvaluation&&B.finalEvaluation.overallEffect, fmt:v=>v?CHG.label("overall",v):"미평가"},
    {key:"adverse",        ko:"부작용(가장 심한 기록)", a:A.worstAdverse, b:B.worstAdverse,
      fmt:v=>v? `${CHG.label("severity",v.severity)} ${CHG.label("adverse",v.code)}`:"기록 없음"},
  ];
  /* 허용된 기술적 문장만 생성 — 권고·판정 문구 금지 */
  const notes=[];
  const fa=A.firstPerceivedStage&&A.firstPerceivedStage.minutes, fb=B.firstPerceivedStage&&B.firstPerceivedStage.minutes;
  if(fa!=null&&fb!=null&&fb<fa) notes.push("변경 후 시험에서는 더 이른 시점에 약효 체감이 기록되었습니다.");
  if(fa!=null&&fb!=null&&fb>fa) notes.push("변경 후 시험에서는 약효 체감이 더 늦은 시점에 기록되었습니다.");
  if(A.maxImprovement!=null&&B.maxImprovement!=null){
    if(B.maxImprovement>A.maxImprovement) notes.push("변경 후 시험에서 더 큰 증상 점수 감소가 기록되었습니다.");
    if(B.maxImprovement<A.maxImprovement) notes.push("변경 후 시험에서 증상 점수 감소가 더 작게 기록되었습니다.");
  }
  const sev={mild:1,moderate:2,severe:3};
  const aeA=A.worstAdverse?sev[A.worstAdverse.severity]||0:0, aeB=B.worstAdverse?sev[B.worstAdverse.severity]||0:0;
  if(B.maxImprovement!=null&&A.maxImprovement!=null&&B.maxImprovement>A.maxImprovement&&aeB>aeA)
    notes.push("변경 후 시험에서는 개선 정도와 함께 부작용 정도도 증가한 것으로 기록되었습니다.");
  else if(aeB>aeA) notes.push("변경 후 시험에서 더 심한 부작용이 기록되었습니다.");
  if(!notes.length) notes.push("두 시험의 기록을 위 표와 그래프로 비교해 보십시오.");
  return {base:A, after:B, rows, notes};
};

/* ---------- 안전: 금지 표현 자체 점검 ---------- */
/* 단정·권고형 표현만 금지 (안내문의 부정형 "권하지 않습니다", "진단을 대신하지 않습니다"는 허용) */
CHG.PROHIBITED = [
  /증량(이 필요|하십시오|을 권|해야)/, /감량(이 필요|하십시오|을 권|해야)/,
  /약을 (늘려|줄여|추가)(야|십시오|해야)?/,
  /진단(입니다|됩니다|되었|할 수 있습니다| 가능성)/,
  /레보도파 반응 (양성|음성)/, /치료 (성공|실패)/, /(^|[^가-힣])(ON|OFF) 확정/,
  /더 적절합니다|계속 치료해야/,
];
CHG.checkSafety = function(obj){
  const bad=[]; (function walk(n,p){ if(n==null)return;
    if(typeof n==="string"){ CHG.PROHIBITED.forEach(re=>{ if(re.test(n)) bad.push({path:p,text:n}); }); }
    else if(Array.isArray(n)) n.forEach((x,i)=>walk(x,p+"["+i+"]"));
    else if(typeof n==="object") Object.entries(n).forEach(([k,v])=>walk(v,p+"."+k));
  })(obj,"$"); return bad;
};

if(typeof module!=="undefined"&&module.exports) module.exports=CHG;
root.CHG=CHG;
})(typeof window!=="undefined"?window:globalThis);
