/* ============================================================
   약효 비교 테스트 v2 — 예상곡선 모듈 (challenge-sim.js)
   본체 약효일지 SIM 탭의 계산 로직을 독립 모듈로 재사용(사본).
   본체 파일은 수정하지 않음. 상대적 작용시간·중첩 모델이며
   실제 혈중농도나 개인 반응 예측이 아님.
   ============================================================ */
(function(root){
"use strict";
const CHGSIM = {};

CHGSIM.DISCLAIMER_USE = "이 기능은 가상 비교를 위한 시뮬레이션입니다. 실제 복용 변경은 의료진과 상의하십시오.";
CHGSIM.DISCLAIMER_MODEL = "예상 곡선은 상대적인 작용 시간과 중첩을 설명하는 모델이며 실제 혈중농도나 개인 반응을 직접 예측한 결과가 아닙니다.";

/* 본체 MED_KINETICS 사본 (v0.9.20 기준) */
const MED_KINETICS = {
  "퍼킨":               {type:"fast",  peakMin:35,  durMin:150, amp:1.0},
  "시네메트":            {type:"fast",  peakMin:40,  durMin:150, amp:1.0},
  "마도파":              {type:"fast",  peakMin:40,  durMin:150, amp:1.0},
  "스타레보":            {type:"fast",  peakMin:45,  durMin:200, amp:1.1},
  "마도파 HBS":          {type:"slow",  peakMin:90,  durMin:300, amp:0.9},
  "시네메트 CR":         {type:"slow",  peakMin:100, durMin:300, amp:0.9},
  "온젠티스(오피카폰)":   {type:"extend",peakMin:0,   durMin:0,   amp:0.25}, /* 온젠티스=오피카폰 (엔타카폰은 컴탄) */
  "컴탄":                {type:"extend",peakMin:0,   durMin:0,   amp:0.25},
  "아질렉트":            {type:"extend",peakMin:0,   durMin:0,   amp:0.15},
  "미라펙스":            {type:"flat",  peakMin:180, durMin:480, amp:0.5},
  "리큅":                {type:"flat",  peakMin:180, durMin:480, amp:0.5},
  "아만타딘":            {type:"flat",  peakMin:120, durMin:360, amp:0.3},
};
CHGSIM.kineticFor = function(name){
  if(MED_KINETICS[name]) return MED_KINETICS[name];
  const n=name||"";
  if(n.includes("HBS")||n.includes("CR")||n.includes("서방")) return {type:"slow",peakMin:90,durMin:300,amp:0.9};
  if(n.includes("온젠티스")||n.includes("오피카폰")||n.includes("엔타카폰")||n.includes("컴탄")||n.includes("콤탄")) return {type:"extend",peakMin:0,durMin:0,amp:0.25};
  if(n.includes("아질렉트")||n.includes("셀레길린")) return {type:"extend",peakMin:0,durMin:0,amp:0.15};
  if(n.includes("미라펙스")||n.includes("리큅")||n.includes("프라미펙솔")||n.includes("로피니롤")) return {type:"flat",peakMin:180,durMin:480,amp:0.5};
  if(n.includes("아만타딘")) return {type:"flat",peakMin:120,durMin:360,amp:0.3};
  return {type:"fast",peakMin:40,durMin:150,amp:1.0};
};
CHGSIM.leddFactorFor = function(name){
  const n=name||"";
  if(n.includes("HBS")||n.includes("CR")||n.includes("서방")) return 0.75;
  if(n.includes("온젠티스")||n.includes("오피카폰")||n.includes("엔타카폰")||n.includes("컴탄")||n.includes("콤탄")) return 0.5;
  if(n.includes("아질렉트")||n.includes("셀레길린")||n.includes("라사길린")) return 100;
  if(n.includes("미라펙스")||n.includes("프라미펙솔")) return 100;
  if(n.includes("리큅")||n.includes("로피니롤")) return 20;
  if(n.includes("아만타딘")) return 1.0;
  return 1.0;
};
CHGSIM.doseCurve = function(prof, t){
  if(t<0) return 0;
  const {peakMin,durMin,amp,type}=prof;
  if(type==="extend") return 0;
  const k = peakMin<=0? 1 : t/peakMin;
  const rise = 1-Math.exp(-3*k);
  const fallTau = Math.max(durMin-peakMin, 30);
  const fall = Math.exp(-Math.max(0,t-peakMin)/fallTau);
  return amp*rise*fall;
};

/* doses: [{name, dose(mg), time:"HH:MM"}] → [{t(분), val}] (본체 simDoseCurvePts와 동일 계산) */
CHGSIM.curvePts = function(doses, opt){
  const o=opt||{}; const START=o.start??5*60, END=o.end??26*60, STEP=o.step??10;
  const pts=[];
  for(let t=START; t<=END; t+=STEP){
    let sum=0;
    (doses||[]).forEach(d=>{
      if(!d.time) return;
      const [h,m]=d.time.split(":").map(Number);
      const doseMin=h*60+m;
      const since=t-doseMin;
      if(since<-60) return;
      const prof=CHGSIM.kineticFor(d.name);
      const factor=CHGSIM.leddFactorFor(d.name);
      const ledd=(d.dose||0)*factor;
      if(prof.type==="extend"){
        if(since>=0 && since<=300) sum += Math.max(0,1-(since/300))*ledd*0.4;
      } else {
        sum += CHGSIM.doseCurve(prof, since)*ledd;
      }
    });
    pts.push({t,val:sum});
  }
  return pts;
};

/* 시험 화면용: 복용 시각 기준 -30~+150분 상대 곡선 (측정 시점 축과 정렬) */
CHGSIM.relativeCurve = function(doses, doseTime){
  if(!doseTime) return [];
  const [h,m]=doseTime.split(":").map(Number);
  const t0=h*60+m;
  return CHGSIM.curvePts(doses,{start:t0-30,end:t0+150,step:5}).map(p=>({t:p.t-t0,val:p.val}));
};

if(typeof module!=="undefined"&&module.exports) module.exports=CHGSIM;
root.CHGSIM=CHGSIM;
})(typeof window!=="undefined"?window:globalThis);
