/* personal-overrides.test.js — Phase 7(개인 곡선 보정 레이어) 회귀 테스트.
 * simulation-drugmodel.js는 DOM 무의존이므로 Node에서 require만으로 테스트한다. */
const path=require("path");

let pass=0, fail=0;
const ok=(c,n)=>{ c?pass++:fail++; console.log((c?"  ✔ ":"  ✘ FAIL: ")+n); };

function freshDM(){
  const modPath=path.join(__dirname,"..","simulation-drugmodel.js");
  delete require.cache[require.resolve(modPath)];
  return require(modPath);
}
function peakTimeOf(DM, doses){
  const c=DM.compositeCurve(doses, 0, 400, 10);
  let bestT=null, bestLed=-Infinity;
  c.rawPoints.forEach(p=>{ if(p.led>bestLed){ bestLed=p.led; bestT=p.t; } });
  return bestT;
}

console.log("== A. setPersonalOverrides 후 compositeCurve 피크 시각 이동 ==");
{
  const DM=freshDM();
  const doses=[{name:"마도파 HBS", dose:100, time:"00:00", dayOffset:0}];
  const basePeak=peakTimeOf(DM, doses);
  ok(basePeak===110, "기본 LEVO_HBS peakMin=110 → 단독 피크도 t=110: "+basePeak);

  DM.setPersonalOverrides({LEVO_HBS:{peakMin:180}});
  const overriddenPeak=peakTimeOf(DM, doses);
  ok(overriddenPeak===180, "peakMin 110→180 오버라이드 후 피크가 t=180으로 이동: "+overriddenPeak);
  ok(overriddenPeak-basePeak===70, "이동량 +70분: "+(overriddenPeak-basePeak));
}

console.log("\n== B. clearPersonalOverrides 후 표준값 복귀, 원본 CURVES 불변 ==");
{
  const DM=freshDM();
  const originalHbs=JSON.parse(JSON.stringify(DM.CURVES.LEVO_HBS));
  const doses=[{name:"마도파 HBS", dose:100, time:"00:00", dayOffset:0}];

  DM.setPersonalOverrides({LEVO_HBS:{peakMin:180}});
  ok(JSON.stringify(DM.CURVES.LEVO_HBS)===JSON.stringify(originalHbs), "오버라이드 적용 중에도 DM.CURVES 원본 객체 값은 그대로(참조가 아니라 값 비교)");
  ok(peakTimeOf(DM, doses)===180, "오버라이드 적용 확인");

  DM.clearPersonalOverrides();
  ok(peakTimeOf(DM, doses)===110, "clearPersonalOverrides 후 표준 peakMin=110으로 복귀: "+peakTimeOf(DM, doses));
  ok(JSON.stringify(DM.CURVES.LEVO_HBS)===JSON.stringify(originalHbs), "clear 후에도 원본 CURVES 값 불변");
}

console.log("\n== C. loadDictionary(=applyDictionary) 호출 후에도 오버라이드 유지 ==");
{
  const DM=freshDM();
  const doses=[{name:"마도파 HBS", dose:100, time:"00:00", dayOffset:0}];
  DM.setPersonalOverrides({LEVO_HBS:{peakMin:180}});
  ok(peakTimeOf(DM, doses)===180, "오버라이드 적용 확인(사전 교체 전)");

  /* loadDictionary는 fetch를 쓰므로 Node 테스트에서는 같은 경로(applyDictionary)를 직접 호출한다 —
     사전 JSON을 다시 적용하는 것과 동일한 효과. */
  const dict={
    version:"test",
    curves: Object.keys(DM.CURVES).map(curveId=>Object.assign({curveId}, DM.CURVES[curveId])),
    drugs: DM.DRUGS,
  };
  DM.applyDictionary(dict);
  ok(DM.dictionarySource==="json", "dictionarySource가 json으로 바뀜(사전이 실제로 교체됐는지 확인)");
  ok(peakTimeOf(DM, doses)===180, "사전 교체 후에도 개인 오버라이드가 유지되어 피크는 여전히 180: "+peakTimeOf(DM, doses));
  ok(DM.getPersonalOverrides().LEVO_HBS.peakMin===180, "getPersonalOverrides()로도 확인됨");
}

console.log("\n== D. 화이트리스트 밖 키·알 수 없는 curveId는 무시 ==");
{
  const DM=freshDM();
  const applied=DM.setPersonalOverrides({
    LEVO_HBS: {peakMin:150, riseShape:"instant", leddFactor:999}, /* riseShape·leddFactor는 화이트리스트 밖 */
    NOT_A_REAL_CURVE: {onsetMin:1}, /* 존재하지 않는 curveId */
  });
  ok(applied.LEVO_HBS.peakMin===150, "허용된 키(peakMin)는 반영됨");
  ok(applied.LEVO_HBS.riseShape===undefined, "화이트리스트 밖 키(riseShape)는 무시됨");
  ok(applied.LEVO_HBS.leddFactor===undefined, "화이트리스트 밖 키(leddFactor)는 무시됨");
  ok(applied.NOT_A_REAL_CURVE===undefined, "존재하지 않는 curveId는 무시됨");
  const model=DM.classify("마도파 HBS");
  ok(model.riseShape==="slow", "적용되지 않은 필드는 표준값(riseShape=slow) 그대로: "+model.riseShape);
}

console.log("\n== E. modifier(ONGENTYS) 오버라이드 — durationMultiplier/coverageWindowMin만 허용 ==");
{
  const DM=freshDM();
  const applied=DM.setPersonalOverrides({ONGENTYS:{durationMultiplier:1.5, coverageWindowMin:1000, note:"임의 문구는 무시되어야 함"}});
  ok(applied.ONGENTYS.durationMultiplier===1.5 && applied.ONGENTYS.coverageWindowMin===1000, "modifier 화이트리스트 키 반영: "+JSON.stringify(applied.ONGENTYS));
  ok(applied.ONGENTYS.note===undefined, "modifier 화이트리스트 밖 키(note)는 무시됨");
  const model=DM.classify("온젠티스");
  ok(model.durationMultiplier===1.5, "classify() 결과에도 반영됨");
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
