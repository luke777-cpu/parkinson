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
  LEVO_IR: {"role": "direct_curve", "onsetMin": 20, "peakMin": 55, "durationMin": 180, "riseShape": "fast", "decayShape": "moderate"},
  LEVO_HBS: {"role": "direct_curve", "onsetMin": 45, "peakMin": 110, "durationMin": 300, "riseShape": "slow", "decayShape": "slow"},
  STALEVO: {"role": "direct_curve", "onsetMin": 25, "peakMin": 60, "durationMin": 220, "riseShape": "fast", "decayShape": "slow"},
  APOMORPHINE: {"role": "direct_curve", "onsetMin": 8, "peakMin": 25, "durationMin": 90, "riseShape": "fast", "decayShape": "moderate"},
  ONGENTYS: {"role": "modifier", "durationMultiplier": 1.35, "coverageWindowMin": 1440, "note": "오피카폰은 1일 1회 복용으로 다음 날까지 레보도파 지속을 보정"},
  ENTACAPONE: {"role": "modifier", "durationMultiplier": 1.25, "coverageWindowMin": 240, "note": "엔타카폰은 레보도파 매 복용과 함께 투여하며 작용 시간이 더 짧음"},
  PRAMI_IR: {"role": "steady_background", "absTauMin": 45, "elimTauMin": 950, "ledPerMg": 24.6, "note": "외부 약동학 시뮬레이터 기준곡선(2026-08, 0.75mg 10일 축적: 최고18.44/최저4.02 LED) 역산 — 소실 시정수 15.8h는 프라미펙솔 반감기와 일치"},
  PRAMI_ER: {"role": "steady_background", "absTauMin": 300, "elimTauMin": 950, "ledPerMg": 24.6, "note": "즉방형과 동일 성분·동일 소실(약물 고유 특성), 흡수만 서방 — IR 기준곡선에서 유도"},
  ROPI_IR: {"role": "background", "riseTauMin": 90, "durationMin": 420, "amp": 0.3},
  ROPI_ER: {"role": "background", "riseTauMin": 150, "durationMin": 1440, "amp": 0.35},
  ROTIGOTINE: {"role": "background", "riseTauMin": 240, "durationMin": 1440, "amp": 0.3},
  AMANTADINE: {"role": "steady_background", "absTauMin": 60, "elimTauMin": 1340, "ledPerMg": 0.244, "note": "외부 약동학 시뮬레이터 기준곡선(2026-08, 100mg 10일 축적: 최고24.42/최저8.34 LED) 역산 — 소실 시정수 22.3h는 아만타딘 반감기와 일치"},
  MAOB_FLAT: {"role": "flat_background", "ledPerLedd": 0.102, "note": "외부 약동학 시뮬레이터 기준(2026-08, 라사길린 1.0mg=LEDD100: 24시간 평탄 10.2 LED) — MAO-B 억제는 매일 복용 시 상수 기여로 모델링, 크기는 LEDD에 비례(10.2%)"},
  ADJUNCT: {"role": "adjunct"},
};

/* ---- 약물 사전 (상품명·별칭 → curveId). 검색·표시용 정보(genericName·formulation·roleLabel)와
   계산용 정보(leddFactor·leddIncluded·refDoseMg)를 함께 가진다.
   같은 성분의 다른 상품명은 aliases 배열에 추가하기만 하면 된다 — 곡선은 새로 만들지 않는다. ---- */
DM.DRUGS = [
  {"genericName": "levodopa/carbidopa (즉방형)", "formulation": "IR", "curveId": "LEVO_IR", "roleLabel": "빠른 레보도파 곡선", "leddFactor": 1.0, "leddIncluded": true, "refDoseMg": 100, "aliases": ["마도파", "시네메트", "퍼킨", "레보도파", "도파민정"]},
  {"genericName": "levodopa/carbidopa (서방형)", "formulation": "HBS/CR", "curveId": "LEVO_HBS", "roleLabel": "지속형 레보도파 곡선", "leddFactor": 0.75, "leddIncluded": true, "refDoseMg": 100, "aliases": ["마도파 HBS", "시네메트 CR"]},
  {"genericName": "levodopa/carbidopa/entacapone", "formulation": "IR 복합", "curveId": "STALEVO", "roleLabel": "빠른 레보도파 곡선 (엔타카폰 포함)", "leddFactor": 1.0, "leddIncluded": true, "refDoseMg": 100, "note": "표기 용량을 레보도파 함량으로 간주한 근사치", "aliases": ["스타레보", "트리레보"], "source": "식약처: 트리레보정(레보도파/카르비도파/엔타카폰) — 스타레보와 동일 성분·용량비, 1:1 대체 가능"},
  {"genericName": "apomorphine", "formulation": "주사", "curveId": "APOMORPHINE", "roleLabel": "속효성 구제 요법 곡선", "leddFactor": 10, "leddIncluded": true, "refDoseMg": 3, "note": "피하주사 구제 요법 — 발현이 매우 빠르고 지속이 짧음", "aliases": ["아포모르핀", "아포카인"]},
  {"genericName": "opicapone", "formulation": "1일 1회", "curveId": "ONGENTYS", "roleLabel": "레보도파 지속 보정 (COMT 억제제, 1일 1회)", "leddFactor": 0.5, "leddIncluded": false, "refDoseMg": 50, "note": "COMT 억제제는 자체 mg 환산이 확립되지 않아 LEDD 합계에서 제외", "aliases": ["온젠티스", "오피카폰"]},
  {"genericName": "entacapone", "formulation": "레보도파 병용", "curveId": "ENTACAPONE", "roleLabel": "레보도파 지속 보정 (COMT 억제제, 매 복용 병용)", "leddFactor": 0.5, "leddIncluded": false, "refDoseMg": 200, "note": "COMT 억제제는 자체 mg 환산이 확립되지 않아 LEDD 합계에서 제외", "aliases": ["엔타카폰", "컴탄", "콤탄"]},
  {"genericName": "pramipexole (즉방형)", "formulation": "IR", "curveId": "PRAMI_IR", "roleLabel": "도파민 작용제 배경효과 (즉방형)", "leddFactor": 100, "leddIncluded": true, "refDoseMg": 0.375, "note": "도파민 작용제는 곡선 모양에서는 완만한 배경효과로만 표시하지만, LEDD 총량 계산에는 포함합니다 (표준 환산표 기준)", "aliases": ["미라펙스", "미라팩스", "피디팩솔", "피디펙솔", "프라미펙솔", "프라펙솔", "미라프"], "source": "식약처: 피디펙솔정(프라미펙솔염산염일수화물) — 미라펙스와 동일 성분"},
  {"genericName": "pramipexole (서방형)", "formulation": "ER", "curveId": "PRAMI_ER", "roleLabel": "도파민 작용제 배경효과 (서방형)", "leddFactor": 100, "leddIncluded": true, "refDoseMg": 0.375, "note": "도파민 작용제는 곡선 모양에서는 완만한 배경효과로만 표시하지만, LEDD 총량 계산에는 포함합니다 (표준 환산표 기준)", "aliases": ["미라펙스 ER", "미라펙스ER", "프라미펙솔 ER", "피디펙솔 ER"]},
  {"genericName": "ropinirole (즉방형)", "formulation": "IR", "curveId": "ROPI_IR", "roleLabel": "도파민 작용제 배경효과 (즉방형)", "leddFactor": 20, "leddIncluded": true, "refDoseMg": 2, "note": "도파민 작용제는 곡선 모양에서는 완만한 배경효과로만 표시하지만, LEDD 총량 계산에는 포함합니다 (표준 환산표 기준)", "aliases": ["리큅", "로피니롤"]},
  {"genericName": "ropinirole (서방형)", "formulation": "XL/ER", "curveId": "ROPI_ER", "roleLabel": "도파민 작용제 배경효과 (서방형)", "leddFactor": 20, "leddIncluded": true, "refDoseMg": 2, "note": "도파민 작용제는 곡선 모양에서는 완만한 배경효과로만 표시하지만, LEDD 총량 계산에는 포함합니다 (표준 환산표 기준)", "aliases": ["리큅 PD", "리큅PD", "리큅 XL", "로피니롤 서방"]},
  {"genericName": "rotigotine", "formulation": "패치", "curveId": "ROTIGOTINE", "roleLabel": "도파민 작용제 배경효과 (패치)", "leddFactor": 30, "leddIncluded": true, "refDoseMg": 4, "note": "도파민 작용제는 곡선 모양에서는 완만한 배경효과로만 표시하지만, LEDD 총량 계산에는 포함합니다 (표준 환산표 기준)", "aliases": ["뉴프로", "로티고틴"]},
  {"genericName": "amantadine", "formulation": "정", "curveId": "AMANTADINE", "roleLabel": "완만한 배경효과 (아만타딘)", "leddFactor": 1.0, "leddIncluded": true, "refDoseMg": 100, "note": "외부 약동학 시뮬레이터 기준곡선(2026-08)을 반영해 완만한 축적형 배경효과로 곡선에 포함합니다", "aliases": ["아만타딘", "피케이멜즈"]},
  {"genericName": "rasagiline / selegiline (MAO-B 억제제)", "formulation": "정", "curveId": "MAOB_FLAT", "roleLabel": "상시 배경효과 (MAO-B 억제제)", "leddFactor": 100, "leddIncluded": true, "refDoseMg": 1, "note": "외부 약동학 시뮬레이터 기준(라사길린 1.0mg 기준 상수 기여)을 반영해 평탄한 배경효과로 곡선에 포함합니다", "aliases": ["아질렉트", "라사길린", "셀레길린", "마오비"]},
  {"genericName": "safinamide (MAO-B 억제제)", "formulation": "정", "curveId": "MAOB_FLAT", "roleLabel": "상시 배경효과 (MAO-B 억제제)", "leddFactor": 2.0, "leddIncluded": true, "refDoseMg": 50, "note": "표준 환산표 기준 50mg=LEDD 100으로 환산 계수를 수정(기존 100은 오류), 라사길린과 같은 평탄 배경효과로 곡선에 포함합니다", "aliases": ["사피나미드", "에퀴피나", "엑스어답션", "자디아고"]},
];

DM.UNREGISTERED_NOTE = "이 약물은 현재 곡선 모델이 등록되어 있지 않습니다. 실제 복용 기록에는 표시되지만 복합 약효 추정곡선 계산에는 포함되지 않습니다.";
DM.NOT_FOUND_GUIDANCE = "현재 약물 사전에 등록되지 않은 약입니다. 성분이 동일한 약이 있는지 확인하시겠습니까?";

/* ---- 런타임 사전 로딩 (작업지시서 §7) ----
   프로그램은 시작 시 drug-dictionary.json을 실제로 읽어 곡선·별칭을 구성한다.
   따라서 새 카피약은 JSON의 aliases에 상품명 한 줄만 추가하면 되고, 코드는 수정하지 않는다.
   위의 DM.CURVES/DM.DRUGS는 오프라인·로드 실패 시 쓰이는 폴백 기본값이며 JSON과 같은 내용이다. */
DM.dictionarySource = "builtin";
DM.applyDictionary = function(json){
  if(!json || !Array.isArray(json.curves) || !Array.isArray(json.drugs)) throw new Error("사전 형식이 올바르지 않습니다");
  const curves={};
  json.curves.forEach(c=>{ if(!c.curveId || !c.role) throw new Error("curveId/role 누락");
    const {curveId, ...rest}=c; curves[curveId]=rest; });
  json.drugs.forEach(dg=>{
    if(!dg.curveId || !Array.isArray(dg.aliases)) throw new Error("drug의 curveId/aliases 누락");
    if(!curves[dg.curveId]) throw new Error(`알 수 없는 curveId: ${dg.curveId}`);
  });
  DM.CURVES=curves;
  DM.DRUGS=json.drugs;
  DM.dictionaryVersion=json.version||null;
  DM.dictionarySource="json";
  _aliasIndex=null; /* 별칭 인덱스 재구성 */
  return {curves:Object.keys(curves).length, drugs:json.drugs.length};
};
DM.loadDictionary = function(url){
  url = url || "drug-dictionary.json";
  if(typeof fetch!=="function") return Promise.resolve({ok:false, reason:"fetch 미지원"});
  return fetch(url, {cache:"no-cache"})
    .then(r=>{ if(!r.ok) throw new Error("HTTP "+r.status); return r.json(); })
    .then(j=>({ok:true, ...DM.applyDictionary(j)}))
    .catch(e=>({ok:false, reason:String(e && e.message || e)})); /* 실패해도 내장 기본값으로 계속 동작 */
};

/* ---- Phase 7: 개인 곡선 보정 레이어 (치료구간 설계도 Phase 7) ----
   실측으로 확인된 개인 파라미터(발현·피크·지속시간 등)를 표준 CURVES 위에 얕게 덮어쓴다.
   원본 DM.CURVES는 절대 변형(mutate)하지 않는다 — 조회 시점(applyPersonalOverride, DM.classify
   진입부)에 Object.assign({}, curve, override)로 새 객체를 만들어 반환한다.
   DM.loadDictionary()로 사전이 교체돼도 이 오버라이드는 별도 레이어이므로 자동으로 유지된다
   (applyDictionary는 DM.CURVES만 바꾸고 _personalOverrides는 건드리지 않는다).
   DM.classify()를 거치는 모든 소비자(곡선탭·SIMTHR·SIMCOV·SIMCAND·SIMDAY 등)가 조회 시점에
   같은 보정 곡선을 보게 되므로, 소비자 쪽 추가 작업이 필요 없다. */
DM.OVERRIDE_WHITELIST = {
  direct_curve: ["onsetMin", "peakMin", "durationMin"],
  modifier: ["durationMultiplier", "coverageWindowMin"],
};
let _personalOverrides = {};
DM.setPersonalOverrides = function(map){
  const next = {};
  Object.keys(map || {}).forEach(curveId => {
    const curve = DM.CURVES[curveId];
    if(!curve){ console.warn(`[DM.setPersonalOverrides] 알 수 없는 curveId "${curveId}" — 무시합니다`); return; }
    const whitelist = DM.OVERRIDE_WHITELIST[curve.role];
    if(!whitelist){ console.warn(`[DM.setPersonalOverrides] curveId "${curveId}"(role:${curve.role})는 개인 보정을 지원하지 않습니다 — 무시합니다`); return; }
    const src = map[curveId] || {};
    const filtered = {};
    Object.keys(src).forEach(k => {
      if(whitelist.includes(k)) filtered[k] = src[k];
      else console.warn(`[DM.setPersonalOverrides] "${curveId}.${k}"는 허용되지 않는 키 — 무시합니다`);
    });
    if(Object.keys(filtered).length) next[curveId] = filtered;
  });
  _personalOverrides = next;
  return DM.getPersonalOverrides();
};
DM.getPersonalOverrides = function(){ return JSON.parse(JSON.stringify(_personalOverrides)); };
DM.clearPersonalOverrides = function(){ _personalOverrides = {}; };
DM.applyPersonalOverride = function(curveId, curve){
  const ov = _personalOverrides[curveId];
  return ov ? Object.assign({}, curve, ov) : curve;
};

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
/* 검토 발견(2026-08-06, 실사용): 부분 문자열 매칭(includes)만 쓰면, 이름에 "서방형"이라고
   분명히 적혀 있어도 그보다 짧은 즉방형 별칭("프라펙솔")이 먼저 걸려서 즉방형(IR)으로
   잘못 인식된다("프라펙솔 서방형"→PRAMI_IR로 오분류, "퍼킨cr"→LEVO_IR로 오분류).
   제형이 틀리면 곡선 모양 자체가 틀려지므로, 이름에 서방형을 가리키는 단어가 있는데
   매칭된 게 즉방형(IR)이면 그 매칭을 신뢰하지 않고 미등록으로 남긴다 — 확신 없는 잘못된
   매칭보다는, 성분 선택 화면(개인 별칭)에서 사용자가 정확한 제형을 직접 고르게 하는 편이
   안전하다("임의 곡선 생성 금지" 원칙의 연장). "확산정"(dispersible)은 서방형이 아니라
   빠르게 녹는 정제라 이 목록에 넣지 않는다. */
const ER_HINT_RE=/서방|서방형|CR|ER형|ER|XR|지속형|패치/i;
DM.findDrug = function(name){
  const n=String(name||"");
  const hit=aliasIndex().find(x=>n.includes(x.alias));
  if(!hit) return null;
  if(ER_HINT_RE.test(n) && hit.drug.formulation==="IR") return null;
  return hit.drug;
};

/* 상품명 → 계산에 쓰는 통합 모델 객체 (곡선 파라미터 + 사전 정보를 합침).
   등록되지 않은 약은 절대 임의 곡선을 만들지 않고 null을 반환한다. */
DM.classify = function(name){
  const drug=DM.findDrug(name);
  if(!drug) return null;
  const curve=DM.applyPersonalOverride(drug.curveId, DM.CURVES[drug.curveId] || {});
  return Object.assign({}, curve, {
    curveId:drug.curveId, genericName:drug.genericName, formulation:drug.formulation,
    roleLabel:drug.roleLabel, leddFactor:drug.leddFactor, leddIncluded:drug.leddIncluded,
    refDoseMg:drug.refDoseMg, note:drug.note,
    category: drug.curveId==="LEVO_IR"||drug.curveId==="LEVO_HBS"||drug.curveId==="STALEVO" ? "levodopa"
            : (curve.role==="background"||curve.role==="steady_background" ? (drug.curveId==="AMANTADINE"?"amantadine":"dopamine_agonist")
            : (curve.role==="flat_background" ? "mao_b"
            : (drug.curveId==="ADJUNCT" ? (drug.genericName==="amantadine"?"amantadine":"mao_b") : "comt"))),
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

/* ---- 정상상태 배경효과 (외부 약동학 시뮬레이터 기준곡선 반영, 2026-08) ----
   매일 같은 시각 반복 복용으로 축적된 정상상태를 닫힌식으로 계산한다:
   C(s) = peak단위 × (1-e^(-s/ka)) × e^(-s/τ) / (1-e^(-1440/τ)),  s = 복용 후 경과분(음수면 +1440 순환)
   순환(wrap) 처리로 "어제 같은 시각 복용분"이 자동 반영되므로 dayOffset<0 복용은 중복 방지를 위해 무시한다.
   가정: 해당 약을 매일 같은 스케줄로 복용 중(축적 상태) — 기준 시뮬레이터의 "Days in treatment" 가정과 동일. */
const RAW_PER_LED = 0.0095; /* 레보도파 100mg 단회 피크(raw≈0.95) = 100 LED 앵커 */
const _steadyNormCache={};
function steadyShape(model, s){
  /* 정상상태 하루 궤적: 오늘 복용분 + 과거 모든 날 복용분의 꼬리(급수합) */
  const ka=model.absTauMin, tau=model.elimTauMin;
  const A=Math.exp(-1440/tau)/(1-Math.exp(-1440/tau)); /* 과거 복용분 누적항 */
  return Math.exp(-s/tau)*((1-Math.exp(-s/ka))+A);
}
function steadyNorm(model){
  const key=model.absTauMin+"/"+model.elimTauMin;
  if(_steadyNormCache[key]) return _steadyNormCache[key];
  let m=0; for(let s=0;s<1440;s+=5){ const v=steadyShape(model,s); if(v>m) m=v; }
  return _steadyNormCache[key]=m;
}
DM.steadyBackgroundValue = function(model, sinceMin){
  let s=sinceMin%1440; if(s<0) s+=1440;
  return steadyShape(model, s)/steadyNorm(model); /* 최고점=1 → ledPerMg는 정상상태 최고 LED/mg */
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
  /* 정상상태·평탄 배경효과는 순환식이 어제 복용분을 이미 포함하므로 당일(dayOffset 0)만 취한다 */
  const steadies=classified.filter(x=>x.model && x.model.role==="steady_background" && !(x.dose.dayOffset<0));
  const flats=classified.filter(x=>x.model && x.model.role==="flat_background" && !(x.dose.dayOffset<0));

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
    steadies.forEach(sx=>{
      const dt=absTime(sx.dose);
      const mg=(sx.dose.dose==null? (sx.model.refDoseMg||1) : +sx.dose.dose);
      const v=DM.steadyBackgroundValue(sx.model, t-dt)*sx.model.ledPerMg*mg*RAW_PER_LED;
      raw+=v; rowPerDrug[sx.dose.name]=(rowPerDrug[sx.dose.name]||0)+v;
    });
    flats.forEach(fx=>{
      const mg=(fx.dose.dose==null? (fx.model.refDoseMg||1) : +fx.dose.dose);
      const v=(mg*(fx.model.leddFactor||1))*fx.model.ledPerLedd*RAW_PER_LED;
      raw+=v; rowPerDrug[fx.dose.name]=(rowPerDrug[fx.dose.name]||0)+v;
    });
    pts.push({t, raw});
    Object.keys(rowPerDrug).forEach(k=>{
      if(!perDrug.find(p=>p.name===k)) perDrug.push({name:k, points:[]});
      perDrug.find(p=>p.name===k).points.push({t, val:rowPerDrug[k]});
    });
  }

  const SCALE=DM.SATURATION_SCALE||1.6;
  const points=pts.map(p=>({t:p.t, val: 100*(1-Math.exp(-p.raw/SCALE))}));
  /* Phase 1(치료구간 설계도): 표시용 points(0~100 정규화)는 그대로 두고,
     LED 원단위(raw)를 rawPoints로 별도 보존한다. "부족분 20 LED" 같은 계산에는
     정규화된 0~100 값이 아니라 이 원단위가 필요하다. 기존 호출부는 points만 쓰므로 영향 없음. */
  const rawPoints=pts.map(p=>({t:p.t, led:p.raw}));

  let leddTotal=0; const leddBreakdown=[];
  classified.forEach(x=>{
    if(!x.model || !x.model.leddIncluded) return;
    const led=(x.dose.dose||0)*x.model.leddFactor;
    leddTotal+=led; leddBreakdown.push({name:x.dose.name, dose:x.dose.dose, ledd:Math.round(led)});
  });

  return { points, rawPoints, perDrug, unregistered, adjuncts, modifiersApplied, leddTotal:Math.round(leddTotal), leddBreakdown };
};

if(typeof module!=="undefined"&&module.exports) module.exports=DM;
root.SIMDRUG=DM;
})(typeof window!=="undefined"?window:globalThis);
