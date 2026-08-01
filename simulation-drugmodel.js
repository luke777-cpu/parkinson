/* ============================================================
   simulation-drugmodel.js — 파킨슨 약물 사전 + 복합 약효 추정곡선 엔진 (v1.1)
   책임: 상품명이 아니라 "성분·제형(curveId)" 중심으로 약을 관리한다.
   같은 성분의 여러 상품명(오리지널·제네릭)은 별칭(aliases)으로 하나의 curveId에 연결되므로,
   새 카피약이 나와도 곡선을 새로 만들 필요 없이 별칭만 추가하면 된다.

   구조: DM.CURVES(곡선 계산 파라미터, curveId 기준) + DM.DRUGS(상품명·별칭→curveId 매핑).
   정본 데이터는 drug-dictionary.json에도 동일하게 문서화되어 있고,
   tests/drug-dictionary.test.js가 이 파일의 내용과 JSON이 일치하는지 자동 검사한다.

   절대 하지 않는 것:
   - 실제 혈중농도·개인 반응·치료 결과를 예측하지 않는다.
   - 등록되지 않은 약에 임의의 곡선을 만들지 않는다.
   - 결론·추천·성공 판정 문구를 만들지 않는다 (이 파일은 숫자만 만든다).
   DOM·localStorage에 의존하지 않는다 (Node 단독 테스트 가능).
   ============================================================ */
(function(root){
"use strict";
const DM = {};

/* ---- 곡선 정의 (curveId 기준 — 상품명과 무관, 하나만 관리) ---- */
DM.CURVES = {
  LEVO_IR:      { role:"direct_curve", onsetMin:20, peakMin:55,  durationMin:180, riseShape:"fast", decayShape:"moderate" },
  LEVO_HBS:     { role:"direct_curve", onsetMin:45, peakMin:110, durationMin:300, riseShape:"slow", decayShape:"slow" },
  STALEVO:      { role:"direct_curve", onsetMin:25, peakMin:60,  durationMin:220, riseShape:"fast", decayShape:"slow" },
  COMT_MOD:     { role:"modifier", durationMultiplier:1.35, coverageWindowMin:720 },
  PRAMI_BG:     { role:"background", riseTauMin:150, durationMin:1440, amp:0.35 },
  ROPI_BG:      { role:"background", riseTauMin:150, durationMin:1440, amp:0.35 },
  ROTIGOTINE_BG:{ role:"background", riseTauMin:240, durationMin:1440, amp:0.3 },
  ADJUNCT:      { role:"adjunct" },
};

/* ---- 약물 사전 (상품명·별칭 → curveId). 검색·표시용 정보(genericName·formulation·roleLabel)와
   계산용 정보(leddFactor·leddIncluded·refDoseMg)를 함께 가진다.
   같은 성분의 다른 상품명은 aliases 배열에 추가하기만 하면 된다 — 곡선은 새로 만들지 않는다. ---- */
DM.DRUGS = [
  { genericName:"levodopa/carbidopa (즉방형)", formulation:"immediate_release", curveId:"LEVO_IR",
    roleLabel:"빠른 레보도파 곡선", leddFactor:1.0, leddIncluded:true, refDoseMg:100,
    aliases:["마도파","시네메트","퍼킨","레보도파","도파민정"] },
  { genericName:"levodopa/carbidopa (서방형/HBS/CR)", formulation:"extended_release", curveId:"LEVO_HBS",
    roleLabel:"지속형 레보도파 곡선", leddFactor:0.75, leddIncluded:true, refDoseMg:100,
    aliases:["마도파 HBS","시네메트 CR"] },
  { genericName:"levodopa/carbidopa/entacapone", formulation:"combination", curveId:"STALEVO",
    roleLabel:"빠른 레보도파 곡선 (콤트 억제제 포함)", leddFactor:1.0, leddIncluded:true, refDoseMg:100,
    note:"표기 용량을 레보도파 함량으로 간주한 근사치",
    aliases:["스타레보","트리레보"] },
  { genericName:"entacapone / opicapone (COMT 억제제)", formulation:"tablet", curveId:"COMT_MOD",
    roleLabel:"레보도파 지속 보정 (COMT 억제제)", leddFactor:0.5, leddIncluded:false, refDoseMg:100,
    note:"COMT 억제제는 자체 mg 환산이 확립되지 않아 LEDD 합계에서 제외",
    aliases:["온젠티스","오피카폰","엔타카폰","컴탄","콤탄"] },
  { genericName:"pramipexole", formulation:"tablet", curveId:"PRAMI_BG",
    roleLabel:"도파민 작용제 배경효과", leddFactor:100, leddIncluded:false, refDoseMg:0.375,
    note:"도파민 작용제는 LEDD 합계에서 제외 (배경효과로만 표시)",
    aliases:["미라펙스","미라팩스","피디팩솔","피디펙솔","프라미펙솔"] },
  { genericName:"ropinirole", formulation:"tablet", curveId:"ROPI_BG",
    roleLabel:"도파민 작용제 배경효과", leddFactor:20, leddIncluded:false, refDoseMg:2,
    note:"도파민 작용제는 LEDD 합계에서 제외 (배경효과로만 표시)",
    aliases:["리큅","로피니롤"] },
  { genericName:"rotigotine", formulation:"patch", curveId:"ROTIGOTINE_BG",
    roleLabel:"도파민 작용제 배경효과 (패치)", leddFactor:30, leddIncluded:false, refDoseMg:4,
    note:"도파민 작용제는 LEDD 합계에서 제외 (배경효과로만 표시)",
    aliases:["뉴프로","로티고틴"] },
  { genericName:"amantadine", formulation:"tablet", curveId:"ADJUNCT",
    roleLabel:"보조약 (곡선 미포함)", leddFactor:1.0, leddIncluded:false, refDoseMg:100,
    note:"아만타딘은 등록된 보정값이 없어 복합 약효 추정곡선 계산에는 포함하지 않습니다",
    aliases:["아만타딘"] },
  { genericName:"MAO-B 억제제 (rasagiline/selegiline)", formulation:"tablet", curveId:"ADJUNCT",
    roleLabel:"보조약 (곡선 미포함)", leddFactor:100, leddIncluded:false, refDoseMg:1,
    note:"MAO-B 억제제는 등록된 보정값이 없어 복합 약효 추정곡선 계산에는 포함하지 않습니다",
    aliases:["아질렉트","라사길린","셀레길린"] },
];

DM.UNREGISTERED_NOTE = "이 약물은 현재 곡선 모델이 등록되어 있지 않습니다. 실제 복용 기록에는 표시되지만 복합 약효 추정곡선 계산에는 포함되지 않습니다.";
DM.NOT_FOUND_GUIDANCE = "현재 약물 사전에 등록되지 않은 약입니다. 성분이 동일한 약이 있는지 확인하시겠습니까?";

/* 별칭 인덱스 — 여러 약에 걸쳐 가장 긴 별칭부터 매칭해야 "마도파"가 "마도파 HBS"를
   가로채는 오분류를 막는다. 최초 1회 계산 후 캐시. */
let _aliasIndex=null;
DM.buildAliasIndex = function(){
  const flat=[];
  DM.DRUGS.forEach(drug=>{ (drug.aliases||[]).forEach(alias=>flat.push({alias, drug})); });
  flat.sort((a,b)=>b.alias.length-a.alias.length);
  return flat;
};
function aliasIndex(){ if(!_aliasIndex) _aliasIndex=DM.buildAliasIndex(); return _aliasIndex; }

/* 상품명(오타·부분 문자열 포함) → 약물 사전 항목 */
DM.findDrug = function(name){
  const n=String(name||"");
  const hit=aliasIndex().find(x=>n.includes(x.alias));
  return hit? hit.drug : null;
};

/* 상품명 → 계산에 쓰는 통합 모델 객체 (곡선 파라미터 + 사전 정보를 합침).
   등록되지 않은 약은 절대 임의 곡선을 만들지 않고 null을 반환한다. */
DM.classify = function(name){
  const drug=DM.findDrug(name);
  if(!drug) return null;
  const curve=DM.CURVES[drug.curveId] || {};
  return Object.assign({}, curve, {
    curveId:drug.curveId, genericName:drug.genericName, formulation:drug.formulation,
    roleLabel:drug.roleLabel, leddFactor:drug.leddFactor, leddIncluded:drug.leddIncluded,
    refDoseMg:drug.refDoseMg, note:drug.note,
    category: drug.curveId==="LEVO_IR"||drug.curveId==="LEVO_HBS"||drug.curveId==="STALEVO" ? "levodopa"
            : (curve.role==="background" ? "dopamine_agonist"
            : (drug.curveId==="ADJUNCT" ? (drug.genericName==="amantadine"?"amantadine":"mao_b") : "comt")),
  });
};

/* 검색 — 상품명·성분명·별칭 어디에 매칭돼도 찾을 수 있게 한다 (작업지시서 §6). */
DM.searchDictionary = function(query){
  const q=String(query||"").trim().toLowerCase();
  if(!q) return [];
  const seen=new Set(), out=[];
  DM.DRUGS.forEach(drug=>{
    const hitAlias=(drug.aliases||[]).find(a=>a.toLowerCase().includes(q));
    const hitGeneric=drug.genericName.toLowerCase().includes(q);
    if(hitAlias || hitGeneric){
      (drug.aliases||[]).forEach(a=>{ if(!seen.has(a)){ seen.add(a); out.push({alias:a, genericName:drug.genericName, curveId:drug.curveId}); } });
    }
  });
  return out;
};

/* 두 상품명이 서로 다른 curveId일 때, 기존 용량 숫자를 그대로 옮겨도 되는지 판단.
   표준 용량 단위(refDoseMg)가 크게 다르면(예: 100mg대 레보도파 ↔ 0.375mg대 프라미펙솔)
   그대로 옮기면 위험하므로 false를 반환해 사용자에게 재입력을 요구한다. */
DM.doseCompatible = function(modelA, modelB){
  if(!modelA || !modelB) return false;
  const a=modelA.refDoseMg||1, b=modelB.refDoseMg||1;
  const ratio=Math.max(a,b)/Math.max(Math.min(a,b), 1e-9);
  return ratio<=10;
};

/* ---- 곡선 도형 함수 ---- */
function riseFactor(shape){ return shape==="slow"? 1.6 : 3.0; }
function decayTauFrom(peakMin, durationMin, shape){
  const base=Math.max(durationMin-peakMin, 20);
  return shape==="slow"? base*1.5 : base;
}
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
DM.backgroundDoseValue = function(model, sinceMin){
  if(sinceMin<0) return 0;
  const { riseTauMin, durationMin, amp } = model;
  const rise=1-Math.exp(-sinceMin/riseTauMin);
  const decay=Math.exp(-Math.max(0,sinceMin-durationMin*0.6)/(durationMin*0.5));
  return amp*rise*decay;
};

/* ---- 복합곡선 계산 ----
   doses: [{name, dose, time:"HH:MM", dayOffset?}] — dayOffset 0=계산 대상일, -1=전날(이월분) 등.
   반환: {points, perDrug, unregistered, adjuncts, modifiersApplied, leddTotal, leddBreakdown} */
DM.compositeCurve = function(doses, t0, t1, step){
  step = step||10;
  const list=(doses||[]).filter(d=>d && d.time);
  const classified=list.map(d=>({ dose:d, model:DM.classify(d.name) }));

  const unregistered=classified.filter(x=>!x.model).map(x=>({name:x.dose.name, dose:x.dose.dose, time:x.dose.time, note:DM.UNREGISTERED_NOTE}));
  const adjuncts=classified.filter(x=>x.model && x.model.role==="adjunct").map(x=>({name:x.dose.name, dose:x.dose.dose, time:x.dose.time, note:x.model.note}));
  const directs=classified.filter(x=>x.model && x.model.role==="direct_curve");
  const modifiers=classified.filter(x=>x.model && x.model.role==="modifier");
  const backgrounds=classified.filter(x=>x.model && x.model.role==="background");

  const timeMin=t=>{ const [h,m]=String(t).split(":").map(Number); return h*60+m; };
  const absTime=x=>((x.dayOffset||0)*1440)+timeMin(x.time);
  const modifiersApplied=[];
  directs.forEach(dx=>{
    const dTime=absTime(dx.dose);
    const hit=modifiers.find(mx=>{
      const mTime=absTime(mx.dose);
      let fwd=dTime-mTime; if(fwd<0) fwd+=1440;
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

  const SCALE=DM.SATURATION_SCALE||1.6;
  const points=pts.map(p=>({t:p.t, val: 100*(1-Math.exp(-p.raw/SCALE))}));

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
