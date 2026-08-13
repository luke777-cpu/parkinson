/* ============================================================
   약효 비교 테스트 v2 — 독립 엔진 (challenge-engine.js)
   WORK_ORDER_MEDICATION_CHALLENGE_V2 기반. 본체 무수정·완전 분리.
   순수 계산만 담당 — DOM/네트워크 접근 없음.
   ============================================================ */
(function(root){
"use strict";
const CHG = {};

CHG.STORAGE_KEY = "medicationChallengeDbV2";
CHG.MEDLIST_KEY = "medicationChallengeMedicationListV2";
CHG.V1_KEY = "medicationChallengeDbV1";
CHG.V1_BACKUP_KEY = "medicationChallengeDbV1Backup";
CHG.SCHEMA_VERSION = 2;

/* ---------- 코드 사전 (언어 중립 저장) ---------- */
CHG.TEST_TYPES = [
  {code:"current_regimen", ko:"현재 복용약 반응 확인"},
  {code:"dose_changed",    ko:"용량 변경 후 반응 확인"},
  {code:"medication_added",ko:"약 추가 후 반응 확인"},
  {code:"regimen_changed", ko:"약 조합 변경 후 반응 확인"},
  {code:"time_changed",    ko:"복용 시간 변경 후 반응 확인"},
  {code:"other",           ko:"기타"},
];
CHG.ROLES = [
  {code:"baseline",  ko:"기준 시험"},
  {code:"changed",   ko:"변경 후 시험"},
  {code:"standalone",ko:"단독 시험"},
];
CHG.SYMPTOM_GROUPS = [
  {group:"motor", ko:"운동 증상", items:[
    {code:"bradykinesia",ko:"서동(움직임 느림)"},{code:"hand_movement",ko:"손동작"},{code:"tremor",ko:"떨림"},
    {code:"rigidity",ko:"경직(뻣뻣함)"},{code:"foot_dragging",ko:"발 끌림"},{code:"gait_start",ko:"걷기 시작"},
    {code:"freezing_of_gait",ko:"동결보행"},{code:"toe_curl",ko:"발가락 말림"},{code:"dystonia",ko:"근긴장이상"},
    {code:"postural_instability",ko:"자세 불안정"},{code:"speech",ko:"말하기"},{code:"overall_mobility",ko:"전반적인 움직임"},
    {code:"motor_custom",ko:"기타(운동)"}]},
  {group:"nonmotor", ko:"비운동 증상", items:[
    {code:"fatigue",ko:"피로"},{code:"drowsiness",ko:"졸림"},{code:"concentration",ko:"집중력 저하"},
    {code:"brain_fog",ko:"멍한 느낌"},{code:"apathy",ko:"의욕 저하"},{code:"anxiety",ko:"불안"},
    {code:"depressed_mood",ko:"우울감"},{code:"pain",ko:"통증"},{code:"nonmotor_custom",ko:"기타(비운동)"}]},
  {group:"autonomic", ko:"자율신경 증상", items:[
    {code:"dizziness",ko:"어지럼"},{code:"orthostatic",ko:"기립성 불편"},{code:"cold_sweat",ko:"식은땀"},
    {code:"hyperhidrosis",ko:"과도한 발한"},{code:"palpitation",ko:"두근거림"},{code:"urinary_urgency",ko:"소변 급박감"},
    {code:"constipation",ko:"변비"},{code:"drooling",ko:"침 흘림"},{code:"nausea",ko:"구역감"},
    {code:"thermo",ko:"체온 조절 불편"},{code:"autonomic_custom",ko:"기타(자율신경)"}]},
];
CHG.GROUPS = CHG.SYMPTOM_GROUPS.map(g=>({group:g.group, ko:g.ko}));
const SYM_FLAT = {}; CHG.SYMPTOM_GROUPS.forEach(g=>g.items.forEach(it=>SYM_FLAT[it.code]={...it, group:g.group}));
CHG.symptomInfo = code => SYM_FLAT[code]||null;

CHG.SCORE_RUBRIC = [
  {v:0, ko:"증상 없음"},
  {v:1, ko:"약간 있으나 거의 불편하지 않음"},
  {v:2, ko:"분명히 있으나 활동 가능"},
  {v:3, ko:"활동에 상당한 지장"},
  {v:4, ko:"매우 심하거나 해당 활동이 어려움"},
];
CHG.PERCEIVED_RUBRIC = [
  {v:0, ko:"전혀 모르겠다"},
  {v:1, ko:"아주 조금 느껴진다"},
  {v:2, ko:"어느 정도 느껴진다"},
  {v:3, ko:"분명히 느껴진다"},
  {v:4, ko:"매우 강하게 느껴진다"},
];
CHG.ADVERSE = [
  {code:"dyskinesia",  ko:"이상운동증"},
  {code:"dizziness",   ko:"어지럼"},
  {code:"drowsiness",  ko:"졸림"},
  {code:"nausea",      ko:"메스꺼움"},
  {code:"headache",    ko:"두통"},
  {code:"palpitation", ko:"두근거림"},
  {code:"low_bp",      ko:"혈압 저하 느낌"},
  {code:"anxiety",     ko:"불안·초조"},
  {code:"hallucination",ko:"환시"},
  {code:"confusion",   ko:"혼란"},
  {code:"other",       ko:"기타"},
];
CHG.AE_RUBRIC = [
  {v:0, ko:"없음"},
  {v:1, ko:"가벼움"},
  {v:2, ko:"분명하지만 감당 가능"},
  {v:3, ko:"상당히 불편함"},
  {v:4, ko:"매우 심함"},
];
CHG.AE_WARN_MIN = 3; /* 3·4점이면 중단 안내 */
CHG.STAGES = [
  {stage:"baseline", minutes:0,   ko:"복용 전"},
  {stage:"m30",      minutes:30,  ko:"복용 30분 후"},
  {stage:"m60",      minutes:60,  ko:"복용 60분 후"},
  {stage:"m90",      minutes:90,  ko:"복용 90분 후"},
  {stage:"m120",     minutes:120, ko:"복용 120분 후"},
  {stage:"m180",     minutes:180, ko:"복용 3시간 후"},
  {stage:"m240",     minutes:240, ko:"복용 4시간 후"},
  {stage:"m300",     minutes:300, ko:"복용 5시간 후"},
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
CHG.ko = { testType:dict(CHG.TEST_TYPES), role:dict(CHG.ROLES), stage:dict(CHG.STAGES),
  adverse:dict(CHG.ADVERSE), overall:dict(CHG.OVERALL), aeSummary:dict(CHG.AE_SUMMARY),
  group:Object.fromEntries(CHG.GROUPS.map(g=>[g.group,g.ko])) };
CHG.label = (group, code) => (CHG.ko[group]||{})[code] || code || "";
CHG.symptomLabel = (test, code) => {
  const sel=(test.symptoms||[]).find(s=>s.code===code);
  if(sel && sel.customLabel) return sel.customLabel;
  const info=SYM_FLAT[code];
  return info? info.ko : code;
};

/* ---------- 내 복용약 목록 (별도 저장 키) ---------- */
CHG.emptyMedList = () => ({version:1, meds:[]});
CHG.newMed = (m) => ({
  id:"med_"+Date.now().toString(36)+Math.random().toString(36).slice(2,6),
  name:m.name||"", unitDose:m.unitDose||"", form:m.form||"",
  usualDose:m.usualDose||"", usualTimes:m.usualTimes||[], prn:!!m.prn, memo:m.memo||"",
  createdAt:new Date().toISOString(), lastUsedAt:null,
});

/* ---------- DB / 테스트 골격 ---------- */
CHG.emptyDb = () => ({version:CHG.SCHEMA_VERSION, tests:[], settings:{language:"ko"}, migratedFromV1:false});
CHG.newTest = (o) => ({
  id:"challenge_"+Date.now().toString(36)+Math.random().toString(36).slice(2,6),
  createdAt:new Date().toISOString(),
  status:"in_progress",
  schema:2,
  testType:o.testType||"current_regimen",
  comparisonRole:o.comparisonRole||"standalone",
  baselineTestId:o.baselineTestId||null,        /* 변경 시험이 참조하는 기준 시험 */
  title:o.title||"",
  plannedDoses:o.plannedDoses||[],              /* [{name,dose(mg 숫자),time:"HH:MM"}] — 예상곡선 계산용 */
  medications:o.medications||[],                /* 표시용 스냅샷 [{name,doseText,form,memo}] */
  changeDescription:o.changeDescription||"",
  doseTakenAt:null,                             /* ISO 전체 시각 (자정 안전) */
  symptoms:o.symptoms||[],                      /* [{code, group, customLabel}] 총 1~6개 */
  assessments:[],                               /* [{stage, scheduledMinutes, actualMinutes, recordedAt,
                                                    symptomScores:{code:0~4}, perceivedScore:0~4|null,
                                                    adverseScores:{code:0~4}, note, skipped?}] */
  finalEvaluation:null,
});

/* ---------- 분석 ---------- */
function round1(x){ return Math.round(x*10)/10; }
function avg(nums){ const v=nums.filter(n=>typeof n==="number"&&isFinite(n)); return v.length? round1(v.reduce((a,b)=>a+b,0)/v.length) : null; }

CHG.analyzeTest = function(test){
  const symsByGroup={}; (test.symptoms||[]).forEach(s=>{ (symsByGroup[s.group]||(symsByGroup[s.group]=[])).push(s.code); });
  const groups=Object.keys(symsByGroup);
  const stages=CHG.STAGES.map(st=>{
    const a=(test.assessments||[]).find(x=>x.stage===st.stage && !x.skipped);
    if(!a) return {stage:st.stage, minutes:st.minutes, recorded:false, groupAvg:{}, perceivedScore:null, adverse:[], maxAeScore:0};
    const groupAvg={};
    groups.forEach(g=>{ groupAvg[g]=avg(symsByGroup[g].map(c=>a.symptomScores? a.symptomScores[c]:null)); });
    const adverse=Object.entries(a.adverseScores||{}).filter(([,v])=>v>0).map(([code,score])=>({code,score}));
    return {stage:st.stage, minutes:st.minutes, recorded:true,
      actualMinutes:a.actualMinutes!=null? a.actualMinutes:st.minutes,
      groupAvg, perceivedScore:(typeof a.perceivedScore==="number")? a.perceivedScore:null,
      adverse, maxAeScore:adverse.length? Math.max(...adverse.map(x=>x.score)):0, note:a.note||""};
  });
  const base=stages.find(s=>s.stage==="baseline");
  const baseAvg=g=> base&&base.recorded? base.groupAvg[g] : null;
  /* 그룹별 요약 */
  const groupSummary={};
  groups.forEach(g=>{
    const post=stages.filter(s=>s.recorded && s.stage!=="baseline" && s.groupAvg[g]!=null);
    const b=baseAvg(g);
    const best=post.length? post.reduce((x,s)=>s.groupAvg[g]<x.groupAvg[g]? s:x) : null;
    const firstChange=(b!=null)? (post.find(s=>s.groupAvg[g]<b)||null) : null;
    const m120=stages.find(s=>s.stage==="m120");
    const m120v=(m120&&m120.recorded)? m120.groupAvg[g] : null;
    const minPost=best? best.groupAvg[g]:null;
    /* v2.13.10: m120으로 고정돼있던 재상승 감지를, 실제 기록된 마지막 시점 기준으로 일반화.
       HBS처럼 지속시간이 긴 약은 120분 이후(3~5시간)에도 관찰이 필요해서 시점을 늘렸는데,
       기존 rebound120은 여전히 m120 하나만 봐서 그 뒤의 재상승을 놓치고 있었다. */
    const recordedPost=stages.filter(s=>s.recorded && s.stage!=="baseline" && s.groupAvg[g]!=null);
    const last=recordedPost.length? recordedPost[recordedPost.length-1] : null;
    const lastv=last? last.groupAvg[g] : null;
    groupSummary[g]={
      baseline:b,
      perStage:Object.fromEntries(stages.map(s=>[s.stage, s.recorded? s.groupAvg[g]:null])),
      delta:Object.fromEntries(stages.filter(s=>s.stage!=="baseline").map(s=>[s.stage,(b!=null&&s.recorded&&s.groupAvg[g]!=null)? round1(b-s.groupAvg[g]):null])),
      firstChangeStage:firstChange? {stage:firstChange.stage,minutes:firstChange.minutes}:null,
      bestStage:best? {stage:best.stage,minutes:best.minutes,avg:best.groupAvg[g]}:null,
      maxImprovement:(b!=null&&minPost!=null)? round1(b-minPost):null,
      at120:m120v,
      rebound120:(m120v!=null&&minPost!=null&&m120!==best)? m120v>minPost : false, /* 최저점 이후 120분 재상승 (하위호환, m120 고정) */
      atLast:lastv,
      reboundLast:(lastv!=null&&minPost!=null&&last!==best)? lastv>minPost : false, /* 최저점 이후 실제 마지막 기록시점 재상승 */
    };
  });
  const firstPerceived=stages.find(s=>s.recorded&&s.perceivedScore!=null&&s.perceivedScore>=1)||null;
  const firstClear=stages.find(s=>s.recorded&&s.perceivedScore!=null&&s.perceivedScore>=3)||null;
  const firstAdverse=stages.find(s=>s.recorded&&s.adverse.length>0)||null;
  let worstAdverse=null;
  stages.forEach(s=>s.adverse.forEach(ae=>{ if(!worstAdverse||ae.score>worstAdverse.score) worstAdverse={...ae, stage:s.stage, minutes:s.minutes}; }));
  return {
    testId:test.id, title:test.title, testType:test.testType, comparisonRole:test.comparisonRole,
    stages, groups, groupSummary,
    firstPerceivedStage:firstPerceived? {stage:firstPerceived.stage,minutes:firstPerceived.minutes,score:firstPerceived.perceivedScore}:null,
    firstClearStage:firstClear? {stage:firstClear.stage,minutes:firstClear.minutes}:null,
    firstAdverseStage:firstAdverse? {stage:firstAdverse.stage,minutes:firstAdverse.minutes}:null,
    worstAdverse,
    finalEvaluation:test.finalEvaluation||null,
    recordedStageCount:stages.filter(s=>s.recorded).length,
  };
};

/* ---------- 기준·변경 비교 ---------- */
CHG.compareTests = function(baseTest, afterTest){
  const A=CHG.analyzeTest(baseTest), B=CHG.analyzeTest(afterTest);
  const gRows=[];
  const allGroups=[...new Set([...A.groups,...B.groups])];
  allGroups.forEach(g=>{
    const a=A.groupSummary[g], b=B.groupSummary[g];
    gRows.push({key:"imp_"+g, ko:`${CHG.label("group",g)} 최대 개선`,
      a:a? a.maxImprovement:null, b:b? b.maxImprovement:null, fmt:v=>v==null?"기록 부족":v+"점"});
  });
  const rows=[
    {key:"firstPerceived", ko:"최초 체감 시점", a:A.firstPerceivedStage&&A.firstPerceivedStage.minutes, b:B.firstPerceivedStage&&B.firstPerceivedStage.minutes, fmt:v=>v==null?"기록 없음":v+"분"},
    {key:"firstClear", ko:"분명한 체감 시점", a:A.firstClearStage&&A.firstClearStage.minutes, b:B.firstClearStage&&B.firstClearStage.minutes, fmt:v=>v==null?"기록 없음":v+"분"},
    ...gRows,
    {key:"m120motor", ko:"120분 운동 증상 평균", a:(A.groupSummary.motor||{}).at120, b:(B.groupSummary.motor||{}).at120, fmt:v=>v==null?"기록 없음":v},
    {key:"overall", ko:"사용자 종합평가", a:A.finalEvaluation&&A.finalEvaluation.overallEffect, b:B.finalEvaluation&&B.finalEvaluation.overallEffect, fmt:v=>v?CHG.label("overall",v):"미평가"},
    {key:"adverse", ko:"부작용(최고 점수)", a:A.worstAdverse, b:B.worstAdverse,
      fmt:v=>v? `${CHG.label("adverse",v.code)} ${v.score}점`:"기록 없음"},
  ];
  return {base:A, after:B, rows};
};

/* ---------- 안전: 금지 표현 자체 점검 (§16) ---------- */
CHG.PROHIBITED = [
  /용량을 (늘리|줄이)는 것이 좋습니다/, /증량(이 필요|하십시오|을 권|해야)/, /감량(이 필요|하십시오|을 권|해야)/,
  /약을 (늘려|줄여|추가)(야|십시오|해야)/, /추가 복용하십시오/,
  /이 약이 더 적절합니다/, /더 적절합니다|계속 치료해야/,
  /진단(입니다|됩니다|되었|할 수 있습니다| 가능성)/,
  /레보도파 반응 (양성|음성)/, /(^|[^가-힣])(ON|OFF) 상태입니다/, /(^|[^가-힣])(ON|OFF) 확정/,
  /치료(가|는)? (성공|실패)/,
];
CHG.checkSafety = function(obj){
  const bad=[]; (function walk(n,p){ if(n==null)return;
    if(typeof n==="string"){ CHG.PROHIBITED.forEach(re=>{ if(re.test(n)) bad.push({path:p,text:n}); }); }
    else if(Array.isArray(n)) n.forEach((x,i)=>walk(x,p+"["+i+"]"));
    else if(typeof n==="object") Object.entries(n).forEach(([k,v])=>walk(v,p+"."+k));
  })(obj,"$"); return bad;
};

/* ---------- v1 → v2 마이그레이션 ----------
   원본 V1 키는 절대 삭제·수정하지 않고, 백업 사본을 만든 뒤 변환본을 반환한다.
   실패 시 {ok:false}를 반환하고 호출측은 빈 v2로 시작한다. */
const V1_SEV_TO_SCORE={mild:1, moderate:2, severe:4};
const V1_PERCEIVED={uncertain:0, slight:1, clear:3, worse:0};
CHG.migrateV1 = function(v1db){
  try{
    if(!v1db || v1db.version!==1 || !Array.isArray(v1db.tests)) return {ok:false, error:"not_v1"};
    const db2=CHG.emptyDb(); db2.migratedFromV1=true;
    db2.settings={...db2.settings, ...(v1db.settings||{})};
    v1db.tests.forEach(t1=>{
      const t2=CHG.newTest({
        testType:t1.testType||"current_regimen",
        comparisonRole:"standalone",
        title:t1.title||((t1.medication||{}).name||""),
        plannedDoses:(t1.medication&&t1.medication.name)? [{name:t1.medication.name, dose:parseFloat(t1.medication.dose)||0, time:t1.medication.scheduledTime||""}]:[],
        medications:(t1.medication&&t1.medication.name)? [{name:t1.medication.name, doseText:t1.medication.dose||"", form:t1.medication.dosageForm||"", memo:""}]:[],
        changeDescription:(t1.medication||{}).changeDescription||"",
        symptoms:(t1.symptoms||[]).map(s=>({code:SYM_FLAT[s.code]? s.code:"motor_custom", group:SYM_FLAT[s.code]? SYM_FLAT[s.code].group:"motor",
          customLabel:s.customLabel|| (SYM_FLAT[s.code]? "":(s.code||""))})),
      });
      /* 코드가 바뀐 증상(예: custom→motor_custom)은 점수 키도 함께 매핑 */
      const codeMap={}; (t1.symptoms||[]).forEach(s=>{ codeMap[s.code]=SYM_FLAT[s.code]? s.code:"motor_custom"; });
      t2.id="v1_"+t1.id; t2.createdAt=t1.createdAt||t2.createdAt; t2.status=t1.status||"completed";
      t2.doseTakenAt=t1.medication&&t1.medication.doseTakenAt? t1.medication.doseTakenAt:null;
      t2.migratedFromV1=true;
      (t1.assessments||[]).forEach(a1=>{
        const adverseScores={};
        (a1.adverseEffects||[]).forEach(ae=>{ if(ae.code&&ae.code!=="none") adverseScores[ae.code]=V1_SEV_TO_SCORE[ae.severity]??1; });
        t2.assessments.push({
          stage:a1.stage, scheduledMinutes:a1.scheduledMinutes??0, actualMinutes:a1.actualMinutes??null,
          recordedAt:a1.recordedAt||"",
          symptomScores:Object.fromEntries(Object.entries(a1.symptomScores||{}).map(([k,v])=>[codeMap[k]||k, v])),
          perceivedScore:(a1.perceivedEffect in V1_PERCEIVED)? V1_PERCEIVED[a1.perceivedEffect]:null,
          adverseScores,
          note:[a1.note||"", a1.perceivedEffect==="worse"? "(v1 체감: 오히려 더 불편)":""].filter(Boolean).join(" "),
          skipped:!!a1.skipped,
        });
      });
      t2.finalEvaluation=t1.finalEvaluation||null;
      db2.tests.push(t2);
    });
    return {ok:true, db2};
  }catch(e){ return {ok:false, error:String(e)}; }
};

if(typeof module!=="undefined"&&module.exports) module.exports=CHG;
root.CHG=CHG;
})(typeof window!=="undefined"?window:globalThis);
