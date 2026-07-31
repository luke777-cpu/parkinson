/* ============================================================
   simulation-drugmodel.js — 약물 모델 + 복합 약효 추정곡선 엔진 (전면 재설계 v1.0)
   책임: 약물군·제형별 특성으로 개별 곡선을 만들고, 역할(직접/보정/배경/보조)에 따라
   하나의 "복합 도파민성 약효 추정곡선"으로 합친다.

   절대 하지 않는 것:
   - 실제 혈중농도·개인 반응·치료 결과를 예측하지 않는다.
   - 등록되지 않은 약에 임의의 곡선을 만들지 않는다.
   - 결론·추천·성공 판정 문구를 만들지 않는다 (이 파일은 숫자만 만든다).
   DOM·localStorage에 의존하지 않는다 (Node 단독 테스트 가능).
   ============================================================ */
(function(root){
"use strict";
const DM = {};

/* ---- 약물 모델 레지스트리 ----
   role: "direct_curve"(독립 곡선) | "modifier"(다른 곡선 보정) | "background"(배경효과) | "adjunct"(보조, 곡선 없음)
   이름 매칭은 하드코딩된 약 하나하나가 아니라 약물군·제형 단위로 묶는다. */
DM.MODELS = [
  { match:["마도파 HBS","시네메트 CR","서방","HBS","CR"], id:"levodopa_er", category:"levodopa", formulation:"extended_release",
    role:"direct_curve", roleLabel:"지속형 레보도파 곡선", onsetMin:45, peakMin:110, durationMin:300,
    riseShape:"slow", decayShape:"slow", leddFactor:0.75, leddIncluded:true, refDoseMg:100 },
  { match:["스타레보"], id:"levodopa_combo", category:"levodopa", formulation:"combination",
    role:"direct_curve", roleLabel:"빠른 레보도파 곡선 (콤트 억제제 포함)", onsetMin:25, peakMin:60, durationMin:220,
    riseShape:"fast", decayShape:"slow", leddFactor:1.0, leddIncluded:true, refDoseMg:100,
    note:"표기 용량을 레보도파 함량으로 간주한 근사치" },
  { match:["마도파","시네메트","퍼킨","레보도파","도파민정"], id:"levodopa_ir", category:"levodopa", formulation:"immediate_release",
    role:"direct_curve", roleLabel:"빠른 레보도파 곡선", onsetMin:20, peakMin:55, durationMin:180,
    riseShape:"fast", decayShape:"moderate", leddFactor:1.0, leddIncluded:true, refDoseMg:100 },
  { match:["온젠티스","오피카폰","엔타카폰","컴탄","콤탄"], id:"comt_modifier", category:"comt", formulation:"tablet",
    role:"modifier", roleLabel:"레보도파 지속 보정 (COMT 억제제)", durationMultiplier:1.35, coverageWindowMin:720,
    leddFactor:0.5, leddIncluded:false, refDoseMg:100,
    note:"COMT 억제제는 자체 mg 환산이 확립되지 않아 LEDD 합계에서 제외" },
  { match:["미라펙스","프라미펙솔"], id:"agonist_pramipexole", category:"dopamine_agonist", formulation:"extended_release",
    role:"background", roleLabel:"도파민 작용제 배경효과", riseTauMin:150, durationMin:1440, amp:0.35,
    leddFactor:100, leddIncluded:false, refDoseMg:0.375,
    note:"도파민 작용제는 LEDD 합계에서 제외 (배경효과로만 표시)" },
  { match:["리큅","로피니롤"], id:"agonist_ropinirole", category:"dopamine_agonist", formulation:"extended_release",
    role:"background", roleLabel:"도파민 작용제 배경효과", riseTauMin:150, durationMin:1440, amp:0.35,
    leddFactor:20, leddIncluded:false, refDoseMg:2,
    note:"도파민 작용제는 LEDD 합계에서 제외 (배경효과로만 표시)" },
  { match:["뉴프로","로티고틴"], id:"agonist_rotigotine", category:"dopamine_agonist", formulation:"patch",
    role:"background", roleLabel:"도파민 작용제 배경효과 (패치)", riseTauMin:240, durationMin:1440, amp:0.3,
    leddFactor:30, leddIncluded:false, refDoseMg:4,
    note:"도파민 작용제는 LEDD 합계에서 제외 (배경효과로만 표시)" },
  { match:["아만타딘"], id:"amantadine_adjunct", category:"amantadine", formulation:"tablet",
    role:"adjunct", roleLabel:"보조약 (곡선 미포함)", leddFactor:1.0, leddIncluded:false, refDoseMg:100,
    note:"아만타딘은 등록된 보정값이 없어 복합 약효 추정곡선 계산에는 포함하지 않습니다" },
  { match:["아질렉트","라사길린","셀레길린"], id:"mao_b_adjunct", category:"mao_b", formulation:"tablet",
    role:"adjunct", roleLabel:"보조약 (곡선 미포함)", leddFactor:100, leddIncluded:false, refDoseMg:1,
    note:"MAO-B 억제제는 등록된 보정값이 없어 복합 약효 추정곡선 계산에는 포함하지 않습니다" },
];

DM.UNREGISTERED_NOTE = "이 약물은 현재 곡선 모델이 등록되어 있지 않습니다. 실제 복용 기록에는 표시되지만 복합 약효 추정곡선 계산에는 포함되지 않습니다.";

DM.classify = function(name){
  const n=String(name||"");
  for(const m of DM.MODELS){ if(m.match.some(k=>n.includes(k))) return m; }
  return null; /* 미등록 — 절대 임의 곡선을 만들지 않는다 */
};

/* ---- 곡선 도형 함수 ---- */
function riseFactor(shape){ return shape==="slow"? 1.6 : 3.0; }
function decayTauFrom(peakMin, durationMin, shape){
  const base=Math.max(durationMin-peakMin, 20);
  return shape==="slow"? base*1.5 : base;
}
/* 직접곡선형 1회 복용의 상대값(0~약1) — onset 이전은 0, 이후 상승·하강 */
DM.directDoseValue = function(model, sinceMin, durationOverrideMin){
  if(sinceMin<0) return 0;
  const { onsetMin, peakMin } = model;
  const durationMin = durationOverrideMin || model.durationMin;
  if(sinceMin<onsetMin) return 0;
  if(sinceMin<=peakMin){
    const u=(sinceMin-onsetMin)/Math.max(1,(peakMin-onsetMin));
    return 1-Math.exp(-riseFactor(model.riseShape)*u);
  }
  const tau=decayTauFrom(peakMin, durationMin, model.decayShape);
  const peakVal=1-Math.exp(-riseFactor(model.riseShape)*1);
  return peakVal*Math.exp(-(sinceMin-peakMin)/tau);
};
/* 배경효과형 1회 복용의 상대값 — 완만한 상승, 뾰족한 봉우리 없이 오래 지속 */
DM.backgroundDoseValue = function(model, sinceMin){
  if(sinceMin<0) return 0;
  const { riseTauMin, durationMin, amp } = model;
  const rise=1-Math.exp(-sinceMin/riseTauMin);
  const decay=Math.exp(-Math.max(0,sinceMin-durationMin*0.6)/(durationMin*0.5));
  return amp*rise*decay;
};

/* ---- 복합곡선 계산 ----
   doses: [{name, dose, time:"HH:MM"}] — 하루 기준. t0/t1/step: 분 단위 계산 구간.
   반환: {points:[{t,val}], perDrug:[{name,role,points}], unregistered:[{name,dose,time}],
          adjuncts:[{name,dose,time,note}], modifiersApplied:[{name,affects:[...]}], leddTotal, leddBreakdown} */
DM.compositeCurve = function(doses, t0, t1, step){
  step = step||10;
  const list=(doses||[]).filter(d=>d && d.time);
  const classified=list.map(d=>({ dose:d, model:DM.classify(d.name) }));

  const unregistered=classified.filter(x=>!x.model).map(x=>({name:x.dose.name, dose:x.dose.dose, time:x.dose.time, note:DM.UNREGISTERED_NOTE}));
  const adjuncts=classified.filter(x=>x.model && x.model.role==="adjunct").map(x=>({name:x.dose.name, dose:x.dose.dose, time:x.dose.time, note:x.model.note}));
  const directs=classified.filter(x=>x.model && x.model.role==="direct_curve");
  const modifiers=classified.filter(x=>x.model && x.model.role==="modifier");
  const backgrounds=classified.filter(x=>x.model && x.model.role==="background");

  /* 보정형: 같은 날 커버리지 안에 있는 직접곡선의 durationMin을 늘린다 (자체 봉우리는 만들지 않음) */
  const timeMin=t=>{ const [h,m]=String(t).split(":").map(Number); return h*60+m; };
  /* dose.dayOffset: 0=계산 대상일, -1=전날 등. 절대시간 = dayOffset*1440 + 시:분.
     검토 반영: 전날 밤 복용한 보정형(COMT)·배경형(도파민 작용제) 약이 다음날 곡선에
     반영되도록, UI가 medsForSimulationDay()로 전날분을 dayOffset:-1로 함께 넘겨준다.
     dayOffset이 없는 기존 호출(단일 목록 안에서 시각만으로 비교)도 그대로 동작해야 하므로,
     절대시간 차이가 음수면 "보정약이 이전 주기에 복용됐다"고 보고 1440분을 더해 감싼다. */
  const absTime=x=>((x.dayOffset||0)*1440)+timeMin(x.time);
  const modifiersApplied=[];
  directs.forEach(dx=>{
    const dTime=absTime(dx.dose);
    const hit=modifiers.find(mx=>{
      const mTime=absTime(mx.dose);
      let fwd=dTime-mTime; if(fwd<0) fwd+=1440; /* 자정을 넘는 보정 커버리지 */
      return fwd>=0 && fwd<=mx.model.coverageWindowMin;
    });
    dx.durationOverrideMin = hit? Math.round(dx.model.durationMin*hit.model.durationMultiplier) : null;
    if(hit){
      let rec=modifiersApplied.find(m=>m.name===hit.dose.name);
      if(!rec){ rec={name:hit.dose.name, affects:[]}; modifiersApplied.push(rec); }
      rec.affects.push(`${dx.dose.name} ${dx.dose.time}`);
    }
  });

  const perDrug=[];
  const pts=[];
  for(let t=t0; t<=t1; t+=step){
    let raw=0;
    const rowPerDrug={};
    directs.forEach(dx=>{
      const dt=absTime(dx.dose);
      const doseFactor=(dx.dose.dose==null?1:(+dx.dose.dose/(dx.model.refDoseMg||100)));
      const v=DM.directDoseValue(dx.model, t-dt, dx.durationOverrideMin)*doseFactor*dx.model.leddFactor;
      raw+=v; rowPerDrug[dx.dose.name]=(rowPerDrug[dx.dose.name]||0)+v;
    });
    backgrounds.forEach(bx=>{
      const dt=absTime(bx.dose);
      const doseFactor=(bx.dose.dose==null?1:(+bx.dose.dose/(bx.model.refDoseMg||1)));
      const v=DM.backgroundDoseValue(bx.model, t-dt)*Math.min(2,doseFactor);
      raw+=v; rowPerDrug[bx.dose.name]=(rowPerDrug[bx.dose.name]||0)+v;
    });
    pts.push({t, raw});
    Object.keys(rowPerDrug).forEach(k=>{
      if(!perDrug.find(p=>p.name===k)) perDrug.push({name:k, points:[]});
      perDrug.find(p=>p.name===k).points.push({t, val:rowPerDrug[k]});
    });
  }

  /* 포화함수: 무한 합산 방지, 0~100으로 정규화 (절대값 예측이 목적이 아니라 상대 비교가 목적) */
  const SCALE=DM.SATURATION_SCALE||1.6;
  const points=pts.map(p=>({t:p.t, val: 100*(1-Math.exp(-p.raw/SCALE))}));

  /* LEDD (참고용 크기 비교 — 곡선 모양과는 별도) */
  let leddTotal=0; const leddBreakdown=[];
  classified.forEach(x=>{
    if(!x.model || !x.model.leddIncluded) return;
    const led=(x.dose.dose||0)*x.model.leddFactor;
    leddTotal+=led; leddBreakdown.push({name:x.dose.name, dose:x.dose.dose, ledd:Math.round(led)});
  });

  return { points, perDrug, unregistered, adjuncts, modifiersApplied, leddTotal:Math.round(leddTotal), leddBreakdown };
};

if(typeof module!=="undefined"&&module.exports) module.exports=DM;
root.SIMDRUG=DM;
})(typeof window!=="undefined"?window:globalThis);
