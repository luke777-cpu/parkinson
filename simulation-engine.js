/* ============================================================
   simulation-engine.js — Parkinson Medication Simulation Platform v1.0
   순수 계산 엔진. DOM·localStorage에 의존하지 않는다 (Node에서도 테스트 가능).
   책임: 복약안(doses) → 상대 PK 곡선 → 예상 출력 곡선 → 지표(metrics).
   그래프·문장·비교는 이 파일의 책임이 아니다 (simulation-compare.js / simulation-interpret.js / simulation-report.js).
   ============================================================ */
(function(root){
"use strict";
const ENG = {};

/* ---- 약물 동역학 프로필 (본체 MED_KINETICS와 동일한 사본 — 참고용 상대 곡선일 뿐 실제 혈중농도 아님) ---- */
const MED_KINETICS = {
  "퍼킨":               {type:"fast",  peakMin:35,  durMin:150, amp:1.0},
  "시네메트":            {type:"fast",  peakMin:40,  durMin:150, amp:1.0},
  "마도파":              {type:"fast",  peakMin:40,  durMin:150, amp:1.0},
  "스타레보":            {type:"fast",  peakMin:45,  durMin:200, amp:1.1},
  "마도파 HBS":          {type:"slow",  peakMin:90,  durMin:300, amp:0.9},
  "시네메트 CR":         {type:"slow",  peakMin:100, durMin:300, amp:0.9},
  "온젠티스(오피카폰)":   {type:"extend",peakMin:0,   durMin:0,   amp:0.25},
  "컴탄":                {type:"extend",peakMin:0,   durMin:0,   amp:0.25},
  "아질렉트":            {type:"extend",peakMin:0,   durMin:0,   amp:0.15},
  "미라펙스":            {type:"flat",  peakMin:180, durMin:480, amp:0.5},
  "리큅":                {type:"flat",  peakMin:180, durMin:480, amp:0.5},
  "아만타딘":            {type:"flat",  peakMin:120, durMin:360, amp:0.3},
};
ENG.kineticFor = function(name){
  if(MED_KINETICS[name]) return MED_KINETICS[name];
  const n=name||"";
  if(n.includes("HBS")||n.includes("CR")||n.includes("서방")) return {type:"slow",peakMin:90,durMin:300,amp:0.9};
  if(n.includes("온젠티스")||n.includes("오피카폰")||n.includes("엔타카폰")||n.includes("컴탄")||n.includes("콤탄")) return {type:"extend",peakMin:0,durMin:0,amp:0.25};
  if(n.includes("아질렉트")||n.includes("셀레길린")) return {type:"extend",peakMin:0,durMin:0,amp:0.15};
  if(n.includes("미라펙스")||n.includes("리큅")||n.includes("프라미펙솔")||n.includes("로피니롤")) return {type:"flat",peakMin:180,durMin:480,amp:0.5};
  if(n.includes("아만타딘")) return {type:"flat",peakMin:120,durMin:360,amp:0.3};
  return {type:"fast",peakMin:40,durMin:150,amp:1.0};
};
ENG.doseCurve = function(prof, t){
  if(t<0) return 0;
  const {peakMin,durMin,amp,type}=prof;
  if(type==="extend") return 0;
  const k = peakMin<=0? 1 : t/peakMin;
  const rise = 1-Math.exp(-3*k);
  const fallTau = Math.max(durMin-peakMin, 30);
  const fall = Math.exp(-Math.max(0,t-peakMin)/fallTau);
  return amp*rise*fall;
};

/* ---- LEDD 환산 계수 (참고용) ---- */
ENG.leddFactorFor = function(name){
  const n=name||"";
  if(n.includes("HBS")||n.includes("CR")||n.includes("서방")) return 0.75;
  if(n.includes("온젠티스")||n.includes("오피카폰")||n.includes("엔타카폰")||n.includes("컴탄")||n.includes("콤탄")) return 0.5;
  if(n.includes("아질렉트")||n.includes("셀레길린")||n.includes("라사길린")) return 100;
  if(n.includes("미라펙스")||n.includes("프라미펙솔")) return 100;
  if(n.includes("리큅")||n.includes("로피니롤")) return 20;
  if(n.includes("아만타딘")) return 1.0;
  return 1.0;
};

/* ---- 약물 역할 분류 — LEDD·PK 포함 여부를 한 곳에서 결정. 알 수 없는 약은 계산에서 제외한다. ---- */
ENG.medRole = function(name){
  const n=name||"";
  const has=(...ks)=>ks.some(k=>n.includes(k));
  if(has("마도파","시네메트","퍼킨","레보도파","도파민정")) return {category:"levodopa", leddIncluded:true, pkIncluded:true, certainty:"known"};
  if(has("스타레보")) return {category:"levodopa", leddIncluded:true, pkIncluded:true, certainty:"approximate", note:"스타레보는 표기 용량을 레보도파 함량으로 간주한 근사치"};
  if(has("온젠티스","오피카폰","엔타카폰","컴탄","콤탄")) return {category:"comt", leddIncluded:false, pkIncluded:true, certainty:"approximate", note:"COMT 억제제는 자체 mg 환산이 확립되지 않아 합계에서 제외"};
  if(has("아질렉트","라사길린","셀레길린")) return {category:"mao_b", leddIncluded:false, pkIncluded:true, certainty:"approximate", note:"MAO-B 억제제는 이 합계에서 제외"};
  if(has("미라펙스","프라미펙솔","리큅","로피니롤","뉴프로","로티고틴")) return {category:"dopamine_agonist", leddIncluded:false, pkIncluded:true, certainty:"approximate", note:"도파민 작용제는 이 합계에서 제외"};
  if(has("아만타딘")) return {category:"amantadine", leddIncluded:false, pkIncluded:false, certainty:"known", note:"아만타딘은 이 LEDD 합계에 포함하지 않음"};
  return {category:"other", leddIncluded:false, pkIncluded:false, certainty:"unknown", note:"약물 종류를 확인할 수 없어 계산에서 제외"};
};

/* ---- 복약안(doses) → 상대 PK 포인트 배열. t0/t1/step 단위: 분(당일 0시 기준 상대 분) ---- */
ENG.doseCurvePts = function(doses, t0, t1, step){
  step = step||10;
  const pts=[];
  for(let t=t0; t<=t1; t+=step){
    let sum=0;
    (doses||[]).forEach(d=>{
      if(!d.time) return;
      const role=ENG.medRole(d.name);
      if(!role.pkIncluded) return; /* 알 수 없는 약·아만타딘은 PK 곡선에서 제외 */
      const [h,m]=d.time.split(":").map(Number);
      let doseMin=h*60+m; if(doseMin<t0-720) doseMin+=1440;
      const since=t-doseMin;
      if(since<-60) return;
      const prof=ENG.kineticFor(d.name);
      const factor=ENG.leddFactorFor(d.name);
      const equivalentDose=(d.dose||0)*factor;
      if(prof.type==="extend"){
        if(since>=0 && since<=300) sum += Math.max(0,1-(since/300))*equivalentDose*0.4;
      } else {
        sum += ENG.doseCurve(prof, since)*equivalentDose;
      }
    });
    pts.push({t, val:sum});
  }
  return pts;
};

/* ---- 상대 PK → 예상 출력 곡선. cal = {base, top} (당일 실제 출력 범위 또는 일반 모델) ---- */
/* 상한(EXTRAPOLATION_CAP): 현재안 최고치를 넘는 구간은 제한적으로만 외삽한다.
   용량을 올리면 출력이 비례해 올라간다는 잘못된 인상을 주지 않기 위한 천장이며,
   실제로도 레보도파 반응에는 천장 효과가 있다. 용량 차이는 피크보다 체류시간에 더 드러난다. */
ENG.EXTRAPOLATION_CAP = 1.3;
ENG.expectedOutputCurve = function(pkPts, pkMaxRef, cal){
  return pkPts.map(p=>({t:p.t, val:Math.min(100, cal.base + (cal.top-cal.base)*Math.min(ENG.EXTRAPOLATION_CAP, p.val/(pkMaxRef||1)))}));
};

/* ---- 당일 실제 출력 기록으로 범위 보정.
   검토 반영: 개수만으로 "개인 보정"이라 하지 않는다. 기록이 몰려 있거나 복용 전후가 없으면
   personal:false로 떨어뜨리고 사유(reasons)를 함께 돌려준다.
   actualSorted:[{t,val}] 시간순, doses는 복용 전후 판정용(선택) ---- */
ENG.calibrate = function(actualSorted, doses, t0){
  const list=actualSorted||[];
  const reasons=[];
  if(list.length<3) reasons.push("출력 기록이 3개 미만");
  if(list.length){
    const span=list[list.length-1].t-list[0].t;
    if(span<90) reasons.push("기록 시간 범위가 90분 미만");
    const vals=list.map(a=>a.val);
    if(Math.max(...vals)-Math.min(...vals)<10) reasons.push("최고·최저 출력 차이가 10점 미만");
  }
  if(doses && doses.length){
    const t0v=(t0==null?0:t0);
    const doseMins=doses.filter(d=>d.time).map(d=>{ const [h,m]=d.time.split(":").map(Number); let t=h*60+m; if(t<t0v) t+=1440; return t; });
    if(doseMins.length){
      const first=Math.min(...doseMins);
      if(!list.some(a=>a.t<=first+30)) reasons.push("복용 전(또는 복용 직후) 출력 기록 없음");
      if(!doseMins.some(dm=>list.some(a=>a.t>=dm+30 && a.t<=dm+120))) reasons.push("복용 후 30~120분 출력 기록 부족");
    }
  }
  if(list.length>=3 && !reasons.length){
    const vals=list.map(a=>a.val);
    return {base:Math.min(...vals), top:Math.max(...vals), personal:true, n:list.length, reasons:[]};
  }
  if(list.length>=3){
    /* 범위는 쓰되 신뢰도는 낮음으로 표시 */
    const vals=list.map(a=>a.val);
    return {base:Math.min(...vals), top:Math.max(...vals), personal:false, n:list.length, reasons};
  }
  return {base:30, top:85, personal:false, n:list.length, reasons};
};

/* ---- 예상 출력 곡선 → 지표 ---- */
ENG.curveMetrics = function(curve, step){
  step = step||10;
  let peak=null, on=null, dwell80=0, dwell5079=0, dwellLow=0, wear=null;
  curve.forEach(p=>{
    if(!peak||p.val>peak.val) peak=p;
    if(on==null && p.val>=80) on=p.t;
    if(p.val>=80) dwell80+=step; else if(p.val>=50) dwell5079+=step; else if(p.val<20) dwellLow+=step;
  });
  if(peak){ for(const p of curve){ if(p.t>peak.t && p.val<50){ wear=p.t; break; } } }
  return {onT:on, peak, dwell80, dwell5079, dwellLow, wearT:wear, incomplete: peak? peak.val<80 : true};
};

/* ---- LEDD 상세 (합계·행·제외 목록·주석) ---- */
ENG.leddDetail = function(doses){
  const rows=[], excluded=[], notes=new Set();
  let total=0;
  (doses||[]).forEach(d=>{
    const role=ENG.medRole(d.name);
    if(!role.leddIncluded){
      excluded.push(`${d.name} ${d.dose||0}mg${role.certainty==="unknown"?" (종류 확인 불가)":""}`);
      if(role.note) notes.add(role.note);
      return;
    }
    const led=(d.dose||0)*ENG.leddFactorFor(d.name);
    total+=led;
    rows.push(`${d.name} ${d.dose||0}mg → LEDD ${Math.round(led)}${role.certainty==="approximate"?" (근사)":""}`);
    if(role.note) notes.add(role.note);
  });
  return {total, rows, excluded, notes:[...notes]};
};

/* ---- 1단계: 원시 계산 (PK만). 출력 변환은 하지 않는다 ---- */
ENG.computeRawPlan = function(doses, t0, t1, step){
  step = step||10;
  const pkPts = ENG.doseCurvePts(doses, t0, t1, step);
  return {doses, pkPts, pkMax: Math.max(1, ...pkPts.map(p=>p.val)), ledd: ENG.leddDetail(doses), t0, t1, step};
};
/* ---- 2단계: 공통 기준값(pkMaxRef)으로 예상 출력 변환 ----
   검토 반영: 실험안이 각자 자기 최고값으로 정규화되면 50mg·75mg·100mg의 피크가 같아진다.
   반드시 현재안(baseline)의 pkMax를 공통 기준으로 넘겨야 용량 차이가 곡선에 드러난다. */
ENG.applyOutputModel = function(rawPlan, pkMaxRef, calibration, step){
  step = step||rawPlan.step||10;
  const expected = ENG.expectedOutputCurve(rawPlan.pkPts, pkMaxRef, calibration);
  return Object.assign({}, rawPlan, {cal:calibration, pkMaxRef, expected, metrics: ENG.curveMetrics(expected, step)});
};
/* ---- 단일 복약안 단독 계산 (현재안 자체를 그릴 때만 사용) ----
   여러 안을 비교할 때는 computeRawPlan + applyOutputModel(공통 pkMaxRef)를 써야 한다. */
ENG.computePlan = function(doses, t0, t1, actualSorted, step, pkMaxRef){
  step = step||10;
  const raw = ENG.computeRawPlan(doses, t0, t1, step);
  const cal = ENG.calibrate(actualSorted, doses, t0);
  return ENG.applyOutputModel(raw, (pkMaxRef==null? raw.pkMax : pkMaxRef), cal, step);
};

if(typeof module!=="undefined"&&module.exports) module.exports=ENG;
root.SIMENG=ENG;
})(typeof window!=="undefined"?window:globalThis);
