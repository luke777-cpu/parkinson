/* 약효 비교 테스트 — 엔진 단위 + jsdom 통합 테스트
   실행: node challenge/tests/challenge.test.js (저장소 루트에서) */
"use strict";
const fs=require("fs"), path=require("path");
const ROOT=path.resolve(__dirname,"..");
let pass=0, fail=0;
const ok=(c,m)=>{ if(c){pass++;console.log("  ✔ "+m);} else {fail++;console.log("  ✘ FAIL: "+m);} };

const CHG=require(path.join(ROOT,"challenge-report.js")); // engine 포함 로드

console.log("== 엔진 단위 ==");
function mkTest(scores, perceived, aes){ // scores: {stage:avgHelper} 간단 생성
  const t=CHG.newTest({testType:"current_regimen", title:"퍼킨 100mg",
    medication:{name:"퍼킨",dose:"100mg",scheduledTime:"07:00"},
    symptoms:[{code:"foot_dragging",customLabel:""},{code:"gait_start",customLabel:""}]});
  Object.entries(scores).forEach(([st,vals])=>{
    t.assessments.push({stage:st, scheduledMinutes:(CHG.STAGES.find(x=>x.stage===st)||{}).minutes,
      actualMinutes:(CHG.STAGES.find(x=>x.stage===st)||{}).minutes,
      recordedAt:new Date().toISOString(),
      symptomScores:{foot_dragging:vals[0], gait_start:vals[1]},
      perceivedEffect:(perceived||{})[st]||null,
      adverseEffects:(aes||{})[st]||[], note:""});
  });
  return t;
}
{ // 13절 예시 재현: 3.0 → 2.7 없음(생략) 1.7 1.3 2.0
  const t=mkTest({baseline:[3,3], m30:[3,2.4? 2.4:2.4], m60:[2,1.4], m90:[1,1.6], m120:[2,2]},
                 {m60:"clear"}, {m90:[{code:"dyskinesia",severity:"mild"}]});
  // 정수 척도만 쓰므로 다시: baseline 3/3=3.0, m30 3/2, m60 2/1, m90 1/2(=1.5), m120 2/2
  t.assessments=[];
  [["baseline",[3,3],null,[]],["m30",[3,2],"uncertain",[]],["m60",[2,1],"clear",[]],["m90",[1,2],"slight",[{code:"dyskinesia",severity:"mild"}]],["m120",[2,2],"slight",[]]]
    .forEach(([st,v,pe,ae])=>t.assessments.push({stage:st,scheduledMinutes:0,actualMinutes:0,recordedAt:"",symptomScores:{a:v[0],b:v[1]},perceivedEffect:pe,adverseEffects:ae,note:""}));
  t.finalEvaluation={overallEffect:"moderate_effect",adverseEffectSummary:"tolerable",note:""};
  const a=CHG.analyzeTest(t);
  ok(a.baselineScore===3, "복용 전 평균 3.0");
  ok(a.stages.find(s=>s.stage==="m60").avgScore===1.5 && a.stages.find(s=>s.stage==="m60").delta===1.5, "60분 평균·변화 계산");
  ok(a.bestStage.stage==="m60"||a.bestStage.stage==="m90", "가장 좋은 시점 산출");
  ok(a.maxImprovement===1.5, "최대 개선 1.5점");
  ok(a.firstPerceivedStage.stage==="m60", "최초 체감(조금/분명) 시점");
  ok(a.firstClearStage.stage==="m60", "최초 분명한 체감 시점");
  ok(a.firstAdverseStage.stage==="m90" && a.worstAdverse.code==="dyskinesia", "부작용 최초 시점·항목");
  const lines=CHG.buildResultLines(a).join("\n");
  ok(lines.includes("가장 큰 변화")&&lines.includes("사용자 종합평가: 어느 정도 효과가 있었다"), "결과 문장 생성");
  ok(CHG.checkSafety({a:lines, d:CHG.DISCLAIMER}).length===0, "결과·면책에 금지 표현 없음");
}
{ // 건너뛰기·부분 기록
  const t=mkTest({baseline:[4,4], m60:[2,2]});
  const a=CHG.analyzeTest(t);
  ok(a.stages.find(s=>s.stage==="m30").recorded===false, "미기록 시점 recorded=false");
  ok(a.maxImprovement===2, "부분 기록에서도 최대 개선 계산");
  ok(CHG.buildResultLines(a).some(l=>l.includes("기록 없음")), "미기록은 '기록 없음' 표기(0 아님)");
}
{ // 비교 로직
  const base=mkTest({baseline:[3,3],m60:[2,2],m90:[2,1],m120:[2,2]},{m60:"slight"});
  base.status="completed"; base.finalEvaluation={overallEffect:"moderate_effect",adverseEffectSummary:"none",note:""};
  const after=mkTest({baseline:[3,3],m30:[2,1],m60:[1,1],m120:[1,2]},{m30:"clear"},{m60:[{code:"dyskinesia",severity:"moderate"}]});
  after.medication.dose="150mg"; after.status="completed";
  after.finalEvaluation={overallEffect:"marked_effect",adverseEffectSummary:"tolerable",note:""};
  const c=CHG.compareTests(base,after);
  ok(c.rows.length===7, "비교 표 7항목");
  ok(c.notes.some(n=>n.includes("더 이른 시점")), "허용 문장: 더 이른 체감");
  ok(c.notes.some(n=>n.includes("부작용")&&n.includes("증가")), "허용 문장: 개선과 부작용 동반 증가");
  ok(CHG.checkSafety(c).length===0, "비교 결과에 금지 표현 없음");
  ok(!JSON.stringify(c).includes("적절")&&!JSON.stringify(c).includes("계속 치료"), "권고 문구 부재 재확인");
}

console.log("== jsdom 통합 ==");
const {JSDOM}=require("jsdom");
let html=fs.readFileSync(path.join(ROOT,"index.html"),"utf-8");
/* 외부 스크립트를 인라인으로 치환 (jsdom 네트워크 없이 실행) */
html=html.replace('<script src="challenge-engine.js"></script>', "<script>"+fs.readFileSync(path.join(ROOT,"challenge-engine.js"),"utf-8")+"<\/script>")
         .replace('<script src="challenge-report.js"></script>', "<script>"+fs.readFileSync(path.join(ROOT,"challenge-report.js"),"utf-8")+"<\/script>")
         .replace('<link rel="stylesheet" href="challenge.css">',"");
const rawHtml=fs.readFileSync(path.join(ROOT,"index.html"),"utf-8");
const errs=[];
const dom=new JSDOM(html,{runScripts:"dangerously",url:"https://example.org/challenge/",
  beforeParse(w){ w.addEventListener("error",e=>errs.push(String(e.message))); w.confirm=()=>true; w.alert=()=>{}; }});
const w=dom.window, d=w.document;
setTimeout(()=>{
  ok(errs.length===0, "로드 시 스크립트 오류 없음 ("+errs.join(";")+")");
  ok(w.CHG.STORAGE_KEY==="medicationChallengeDbV1", "독립 저장 키");
  ok(!w.localStorage.getItem("yakhyoDbV1") && !rawHtml.includes("yakhyo"), "본체 저장소·코드 참조 없음");
  ok(d.body.textContent.includes("약효 비교 테스트") && d.body.textContent.includes("증량·감량·추가를 권하는 기능이 아닙니다"), "첫 화면 제목·안전 안내");
  /* 새 테스트 흐름 */
  w.viewSetup();
  d.getElementById("md_name").value="퍼킨"; d.getElementById("md_dose").value="100mg";
  d.getElementById("md_chg").value="기준 시험";
  d.querySelector('#sy_chips .chip[data-k="foot_dragging"]').click();
  d.querySelector('#sy_chips .chip[data-k="gait_start"]').click();
  w.startTest();
  let saved=JSON.parse(w.localStorage.getItem(w.CHG.STORAGE_KEY));
  ok(saved.tests.length===1 && saved.tests[0].status==="in_progress", "테스트 생성·저장");
  ok(saved.tests[0].symptoms.length===2 && saved.tests[0].symptoms.map(s=>s.code).sort().join()==="foot_dragging,gait_start", "증상 코드 저장(언어 중립)");
  /* 복용 전 기록 */
  d.querySelectorAll(".scorerow").forEach(row=>row.querySelector('.scorebtn[data-v="3"]').click());
  d.querySelector('#pe_chips .chip[data-k="uncertain"]').click();
  d.getElementById("as_save").click();
  /* 복용 표시 후 30분 기록 */
  w.markDose();
  d.querySelectorAll(".scorerow").forEach(row=>row.querySelector('.scorebtn[data-v="2"]').click());
  d.querySelector('#pe_chips .chip[data-k="slight"]').click();
  d.querySelector('#ae_chips .chip[data-k="dizziness"]').click();
  const sevSel=d.querySelector('#ae_sev .chips[data-ae="dizziness"] .chip[data-k="severe"]'); sevSel.click();
  ok(d.getElementById("ae_warn").textContent.includes("테스트를 중단하고"), "심한 부작용 경고 표시");
  d.getElementById("as_save").click();
  saved=JSON.parse(w.localStorage.getItem(w.CHG.STORAGE_KEY));
  const m30=saved.tests[0].assessments.find(a=>a.stage==="m30");
  ok(m30 && m30.scheduledMinutes===30 && typeof m30.actualMinutes==="number" && m30.actualMinutes>=0, "예정·실제 시각 함께 저장");
  ok(/T.*Z|[+-]\d{2}:\d{2}/.test(saved.tests[0].medication.doseTakenAt), "복용 시각 ISO 전체 저장(자정 안전)");
  { /* 자정 넘김: 어제 23:30 복용 → 지금(가정) 60분 뒤 기록해도 음수 아님 */
    const m=w.eval(`(function(){ const t=db.tests.find(x=>x.status==="in_progress")||db.tests[0];
      const bak=t.medication.doseTakenAt;
      t.medication.doseTakenAt=new Date(Date.now()-60*60000).toISOString(); /* 60분 전 복용 (날짜 경계 무관) */
      const v=minutesSinceDose(t); t.medication.doseTakenAt=bak; return v; })()`);
    ok(m>=59&&m<=61, "자정 넘김 포함 경과분 계산(60분 전 복용→"+m+"분)"); }
  { const legacy=w.eval(`(function(){ const t=db.tests[0]; const bak=t.medication.doseTakenAt;
      const d=new Date(Date.now()+30*60000); /* 미래 시각 문자열(=어제 그 시각으로 해석돼야 함) */
      t.medication.doseTakenAt=String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0");
      const v=minutesSinceDose(t); t.medication.doseTakenAt=bak; return v; })()`);
    ok(legacy>0, "구버전 HH:MM 데이터 자정 보정("+legacy+"분)"); }
  ok(m30.adverseEffects[0].code==="dizziness" && m30.adverseEffects[0].severity==="severe", "부작용 코드·정도 저장");
  /* 60분 건너뛰기 → 조기 종료 */
  d.getElementById("as_skip").click();
  w.viewFinish();
  d.querySelector('#fe_overall .chip[data-k="moderate_effect"]').click();
  d.querySelector('#fe_ae .chip[data-k="tolerable"]').click();
  w.saveFinal();
  saved=JSON.parse(w.localStorage.getItem(w.CHG.STORAGE_KEY));
  ok(saved.tests[0].status==="completed" && saved.tests[0].finalEvaluation.overallEffect==="moderate_effect", "조기 종료·최종 평가 저장");
  ok(d.body.textContent.includes("약효 비교 테스트 결과") && d.querySelector(".graph svg"), "결과 화면·SVG 그래프");
  ok(d.body.textContent.includes("혈중 약물 농도"), "그래프 면책 문구");
  /* 두 번째 테스트(빠른 주입) 후 비교 */
  const t2id=w.eval(`(function(){
    const t2=CHG.newTest({testType:"dose_changed", title:"퍼킨 150mg",
      medication:{name:"퍼킨",dose:"150mg",scheduledTime:"07:00",changeDescription:"의사와 상의 후 변경"},
      symptoms:[{code:"foot_dragging",customLabel:""},{code:"gait_start",customLabel:""}]});
    [["baseline",[3,3],null],["m30",[1,2],"clear"],["m60",[1,1],"clear"]].forEach(([st,v,pe])=>
      t2.assessments.push({stage:st,scheduledMinutes:0,actualMinutes:0,recordedAt:"",symptomScores:{a:v[0],b:v[1]},perceivedEffect:pe,adverseEffects:[],note:""}));
    t2.status="completed"; t2.finalEvaluation={overallEffect:"marked_effect",adverseEffectSummary:"none",note:""};
    db.tests.push(t2); save(); return t2.id; })()`);
  w.viewCompare(saved.tests[0].id, t2id);
  ok(d.body.textContent.includes("기준 시험")&&d.body.textContent.includes("변경 후 시험")&&d.querySelectorAll(".graph svg path").length>=2, "비교 화면·이중 그래프");
  ok(!/증량이 필요|감량이 필요|약을 늘려|약을 줄여|적절합니다|계속 치료/.test(d.getElementById("app").textContent), "비교 화면에 권고 문구 없음");
  /* 백업 왕복 */
  const backup=w.eval("JSON.stringify(db)");
  w.eval("db=CHG.emptyDb(); save();");
  w.eval(`db=JSON.parse(${JSON.stringify(backup)}); save();`);
  ok(JSON.parse(w.localStorage.getItem(w.CHG.STORAGE_KEY)).tests.length===2, "백업 JSON 왕복 복원");
  /* 재실행 복원 시뮬레이션 */
  const dom2=new JSDOM(html,{runScripts:"dangerously",url:"https://example.org/challenge/",
    beforeParse(w2){ w2.localStorage.setItem("medicationChallengeDbV1", backup); w2.confirm=()=>true; w2.alert=()=>{}; }});
  setTimeout(()=>{
    ok(dom2.window.eval("db.tests.length")===2, "브라우저 재실행 후 데이터 복원");
    /* 모바일·접근성 정적 점검 */
    const css=fs.readFileSync(path.join(ROOT,"challenge.css"),"utf-8");
    ok(/user-scalable=yes/.test(rawHtml)&&/maximum-scale=5\.0/.test(rawHtml), "확대 허용 viewport");
    ok(/min-height:48px|min-height:52px/.test(css)&&/min-width:48px/.test(css), "터치 영역 48px 이상");
    ok(/@page\{ size:A4; margin:12mm \}/.test(css)&&/break-inside:avoid/.test(css), "A4 인쇄·잘림 방지 CSS");
    const sw=fs.readFileSync(path.join(ROOT,"sw.js"),"utf-8");
    ok(/medication-challenge-v1/.test(sw)&&!/yakhyo-v/.test(sw.replace(/\/\*[^*]*\*\//g,"")), "서비스워커 캐시 분리(캐시명 기준)");
    console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
    process.exit(fail?1:0);
  },300);
},400);
