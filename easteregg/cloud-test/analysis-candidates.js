/* ============================================================
   analysis-candidates.js — 치료구간 설계도 Phase 4: 후보안 비교 엔진
   책임: Phase 3에서 찾은 가장 큰 부족 구간을 채우는 여러 방법(용량 추가·시각 이동·
   COMT 추가·작용제 증량·제형 교체)을 각각 곡선으로 다시 계산해서, "구간 내 체류시간이
   얼마나 늘어나는가"로 비교한다.

   설계 원칙 (치료구간_과다과소_설계도 §4):
   - 부족분을 채우는 방법은 여러 개이고 곡선 모양이 전부 다르다. LEDD 합계로는 구분 안 된다.
   - 정렬 기준은 "구간 내 체류시간 증가량"이지 부족분 충족량이 아니다.
   - 상한을 넘기는(초과 시간이 느는) 후보는 반드시 경고 표시한다.
   - "추천", "1위", "가장 좋음" 같은 결론 문구를 만들지 않는다 — 숫자와 사실만 낸다.
   - 이 결과는 환자 화면에 노출하지 않는다(PHS 보고서 전용) — 이 파일 자체는 그 규칙을
     强제하지 않지만(엔진은 화면을 모른다), 호출부(PHS 보고서 빌더)에서만 사용해야 한다.
   - 실제 처방 변경 여부는 담당 의료진이 판단한다. 이 엔진은 그 판단을 위한 자료만 만든다.
   - DOM·localStorage에 의존하지 않는다 (Node 단독 테스트 가능). SIMDRUG가 있어야 동작한다.
   ============================================================ */
(function(root){
"use strict";
const CAND = {};

function getSIMDRUG(){
  if(typeof module!=="undefined"&&module.exports && typeof require==="function"){
    try{ return require("./simulation-drugmodel.js"); }catch(e){}
  }
  return (typeof window!=="undefined"&&window.SIMDRUG) || (typeof SIMDRUG!=="undefined"?SIMDRUG:null);
}
function getSIMCOV(){
  if(typeof module!=="undefined"&&module.exports && typeof require==="function"){
    try{ return require("./analysis-coverage.js"); }catch(e){}
  }
  return (typeof window!=="undefined"&&window.SIMCOV) || (typeof SIMCOV!=="undefined"?SIMCOV:null);
}

/* 시각(HH:MM) ↔ 분 변환 (analysis-clinical.js와 동일 규칙) */
function timeMinToHhmm(m){ m=((m%1440)+1440)%1440; const h=Math.floor(m/60), mm=m%60;
  return `${String(h).padStart(2,"0")}:${String(mm).padStart(2,"0")}`; }

/* baselineDoses: [{name, dose, time:"HH:MM", dayOffset?}] — 그 날 실제 복용 목록(이월분 포함 가능).
   segment: Phase 3의 worstUnder({startMin, endMin, maxDeficitLed, ...}).
   SIMDRUG(약물 사전)를 통해서만 후보를 만든다 — 이름을 하드코딩하지 않는다. */
CAND.buildCandidates = function(baselineDoses, segment, opts){
  const DM=getSIMDRUG();
  const o=opts||{};
  const candidates=[];
  const reasons=[];
  if(!DM){ reasons.push("약물 사전을 불러올 수 없어 후보안을 만들 수 없습니다"); return {candidates, reasons}; }
  if(!segment){ reasons.push("부족 구간이 없어 후보안을 만들 필요가 없습니다"); return {candidates, reasons}; }

  const timeMin=t=>{ const [h,m]=String(t).split(":").map(Number); return h*60+m; };
  const classified = (baselineDoses||[]).map(d=>({dose:d, model:DM.classify(d.name)})).filter(x=>x.model);

  /* 구간 시작 직전의 direct_curve(레보도파 계열) 복용을 찾는다 — 후보 1·2·5의 기준점 */
  const directsBefore = classified.filter(x=>x.model.role==="direct_curve" && timeMin(x.dose.time) <= segment.startMin)
    .sort((a,b)=>timeMin(b.dose.time)-timeMin(a.dose.time));
  const nearest = directsBefore[0] || null;

  /* ① 용량 추가: 가장 가까운 직전 복용과 같은 약을, 부족 구간 시작 60분 전(또는 그 복용 시각+30분 중 늦은 쪽)에 추가 */
  if(nearest){
    const addTime = Math.max(timeMin(nearest.dose.time)+30, segment.startMin-60);
    const doses=baselineDoses.concat([{name:nearest.dose.name, dose:nearest.dose.dose, time:timeMinToHhmm(addTime)}]);
    candidates.push({id:"add_dose", label:`${nearest.dose.name} ${nearest.dose.dose!=null?nearest.dose.dose+"mg":""} 추가 (${timeMinToHhmm(addTime)})`, doses});
  } else reasons.push("용량 추가 후보: 부족 구간 이전에 레보도파 계열 복용이 없어 만들 수 없습니다");

  /* ② 복용 시각 이동: 가장 가까운 직전 복용을 30분 앞당김(이전 복용과 안 겹치게) */
  if(nearest){
    const idx=baselineDoses.indexOf(nearest.dose);
    const prevOther = directsBefore[1];
    const earliestAllowed = prevOther? timeMin(prevOther.dose.time)+30 : 0;
    const newTime = Math.max(earliestAllowed, timeMin(nearest.dose.time)-30);
    if(newTime < timeMin(nearest.dose.time)){
      const doses=baselineDoses.map((d,i)=> i===idx? Object.assign({}, d, {time:timeMinToHhmm(newTime)}) : d);
      candidates.push({id:"shift_earlier", label:`${nearest.dose.name} 복용시각 ${nearest.dose.time}→${timeMinToHhmm(newTime)}로 이동`, doses});
    }
  }

  /* ③ COMT 억제제 추가: 사전에서 role:"modifier"인 약을 찾아, 가장 가까운 직전 복용과 같은 시각에 추가 (이미 있으면 건너뜀) */
  if(nearest){
    const alreadyHasModifier = classified.some(x=>x.model.role==="modifier");
    if(!alreadyHasModifier){
      const comt = (DM.DRUGS||[]).find(d=>{ const c=DM.CURVES&&DM.CURVES[d.curveId]; return c && c.role==="modifier"; });
      if(comt){
        const doses=baselineDoses.concat([{name:comt.aliases[0], dose:comt.refDoseMg||null, time:nearest.dose.time}]);
        candidates.push({id:"add_comt", label:`COMT 억제제(${comt.aliases[0]}) 추가 (${nearest.dose.time})`, doses});
      }
    } else reasons.push("COMT 추가 후보: 이미 COMT 억제제를 복용 중입니다");
  }

  /* ④ 작용제 증량: 이미 복용 중인 background(도파민 작용제) 약이 있으면 그 용량을 1.5배로(가장 흔한 처방 단위 근사) */
  const bg=classified.find(x=>x.model.role==="background" && x.dose.dose!=null);
  if(bg){
    const newDose=Math.round(bg.dose.dose*1.5*1000)/1000;
    const idx=baselineDoses.indexOf(bg.dose);
    const doses=baselineDoses.map((d,i)=> i===idx? Object.assign({}, d, {dose:newDose}) : d);
    candidates.push({id:"increase_agonist", label:`${bg.dose.name} 용량 증량 (${bg.dose.dose}→${newDose}mg)`, doses});
  } else reasons.push("작용제 증량 후보: 현재 복용 중인 배경형(도파민 작용제) 약이 없습니다");

  /* ⑤ 제형 교체: 가장 가까운 직전 복용이 즉방형(LEVO_IR)이면, 사전에서 같은 계열의 서방형(LEVO_HBS)으로 교체 */
  if(nearest && nearest.model.curveId==="LEVO_IR"){
    const hbs=(DM.DRUGS||[]).find(d=>d.curveId==="LEVO_HBS");
    if(hbs){
      const idx=baselineDoses.indexOf(nearest.dose);
      const doses=baselineDoses.map((d,i)=> i===idx? Object.assign({}, d, {name:hbs.aliases[0]}) : d);
      candidates.push({id:"switch_formulation", label:`${nearest.dose.name}→${hbs.aliases[0]}로 교체`, doses});
    }
  }

  return {candidates, reasons};
};

/* baseline·후보들을 각각 곡선으로 계산해 "구간 내 체류시간"으로 비교한다.
   window: {lower, upper}. 정렬은 inWindowMin 증가량(deltaMin) 내림차순 — 부족분 충족량이 아니다. */
CAND.evaluate = function(baselineDoses, candidates, window, opts){
  const DM=getSIMDRUG(), COV=getSIMCOV();
  const o=Object.assign({step:10}, opts||{});
  if(!DM || !COV) return {valid:false, reasons:["엔진을 불러올 수 없습니다"]};
  if(!window || window.lower==null) return {valid:false, reasons:["하한(OFF 역치)을 추정할 수 없어 비교할 수 없습니다"]};

  const evalOne=(doses)=>{
    const composite=DM.compositeCurve(doses, 0, 1440, o.step);
    return COV.analyze(composite.rawPoints, window, {step:o.step});
  };

  const base=evalOne(baselineDoses);
  if(!base.valid) return {valid:false, reasons:base.reasons};

  const rows=(candidates||[]).map(c=>{
    const cov=evalOne(c.doses);
    if(!cov.valid) return {id:c.id, label:c.label, valid:false};
    const deltaMin=cov.inWindowMin-base.inWindowMin;
    const overDeltaMin=cov.overMin-base.overMin;
    return {
      id:c.id, label:c.label, valid:true,
      inWindowMin:cov.inWindowMin, deltaMin,
      overMin:cov.overMin, overDeltaMin,
      crossesUpper: overDeltaMin>0, /* 상한을 더 넘기게 되는지 — 반드시 표시해야 함 */
    };
  });
  rows.sort((a,b)=>{ if(!a.valid) return 1; if(!b.valid) return -1; return b.deltaMin-a.deltaMin; });

  return {
    valid:true,
    baseline:{inWindowMin:base.inWindowMin, underMin:base.underMin, overMin:base.overMin},
    candidates:rows,
  };
};

if(typeof module!=="undefined"&&module.exports) module.exports=CAND;
root.SIMCAND = CAND;
})(typeof window!=="undefined"?window:globalThis);
