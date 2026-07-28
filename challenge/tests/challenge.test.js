/* 약효 비교 테스트 v2 — 엔진·시뮬·타이머 단위 + jsdom 통합
   실행: cd challenge && npm install && npm test */
"use strict";
const fs=require("fs"), path=require("path");
const ROOT=path.resolve(__dirname,"..");
let pass=0, fail=0;
const ok=(c,m)=>{ if(c){pass++;console.log("  ✔ "+m);} else {fail++;console.log("  ✘ FAIL: "+m);} };

const CHG=require(path.join(ROOT,"challenge-report.js"));
const CHGSIM=require(path.join(ROOT,"challenge-sim.js"));
const CHGTIMER=require(path.join(ROOT,"challenge-timer.js"));

console.log("== 엔진 v2 단위 ==");
function mkTest(){
  return CHG.newTest({testType:"current_regimen", comparisonRole:"standalone", title:"퍼킨 100mg",
    plannedDoses:[{name:"퍼킨",dose:100,time:"07:00"}],
    medications:[{name:"퍼킨",doseText:"100mg",form:"",memo:""}],
    symptoms:[
      {code:"foot_dragging",group:"motor",customLabel:""},
      {code:"tremor",group:"motor",customLabel:""},
      {code:"fatigue",group:"nonmotor",customLabel:""},
      {code:"dizziness",group:"autonomic",customLabel:""},
    ]});
}
function addA(t,stage,scores,pe,aes){
  t.assessments.push({stage, scheduledMinutes:0, actualMinutes:0, recordedAt:"",
    symptomScores:scores, perceivedScore:pe??null, adverseScores:aes||{}, note:""});
}
{ const t=mkTest();
  addA(t,"baseline",{foot_dragging:3,tremor:3,fatigue:2,dizziness:1},0);
  addA(t,"m30",{foot_dragging:3,tremor:2,fatigue:2,dizziness:1},0);
  addA(t,"m60",{foot_dragging:2,tremor:1,fatigue:2,dizziness:1},1,{dyskinesia:1});
  addA(t,"m90",{foot_dragging:1,tremor:1,fatigue:1,dizziness:1},3,{dyskinesia:2});
  addA(t,"m120",{foot_dragging:2,tremor:2,fatigue:1,dizziness:1},2);
  t.finalEvaluation={overallEffect:"moderate_effect",adverseEffectSummary:"tolerable",note:""};
  const a=CHG.analyzeTest(t);
  ok(a.groups.slice().sort().join()==="autonomic,motor,nonmotor","3그룹 분리 인식");
  ok(a.groupSummary.motor.baseline===3 && a.groupSummary.motor.perStage.m60===1.5, "운동 그룹 시점 평균");
  ok(a.groupSummary.nonmotor.perStage.m90===1 && a.groupSummary.autonomic.baseline===1, "비운동·자율신경 분리 계산");
  ok(a.groupSummary.motor.delta.m90===2, "기준 대비 변화(운동 m90 2점 감소)");
  ok(a.groupSummary.motor.bestStage.minutes===90 && a.groupSummary.motor.maxImprovement===2, "가장 좋은 시점·최대 개선");
  ok(a.groupSummary.motor.rebound120===true, "120분 재상승 감지");
  ok(a.groupSummary.autonomic.maxImprovement===0, "자율신경 변화 없음 계산");
  ok(a.firstPerceivedStage.minutes===60 && a.firstClearStage.minutes===90, "최초 체감(≥1)·분명한 체감(≥3) 구분");
  ok(a.firstAdverseStage.minutes===60 && a.worstAdverse.code==="dyskinesia" && a.worstAdverse.score===2, "부작용 최초·최고");
  const interp=CHG.buildInterpretation(a);
  ok(interp.some(s=>s.includes("운동 증상")&&s.includes("가장 낮은")), "허용 해석: 그룹 최저 시점");
  ok(interp.some(s=>s.includes("다시 상승")), "허용 해석: 120분 재상승");
  ok(interp.some(s=>s.includes("자율신경")&&s.includes("뚜렷한 변화가 기록되지 않았")), "허용 해석: 변화 없음");
  ok(CHG.checkSafety({i:interp, t:CHG.buildResultText(t)}).length===0, "결과 전체 금지 표현 0건");
  /* 비교 */
  const t2=mkTest(); t2.title="퍼킨 150mg"; t2.comparisonRole="changed"; t2.plannedDoses=[{name:"퍼킨",dose:150,time:"07:00"}];
  addA(t2,"baseline",{foot_dragging:3,tremor:3,fatigue:2,dizziness:1},0);
  addA(t2,"m30",{foot_dragging:1,tremor:1,fatigue:2,dizziness:1},3,{dyskinesia:3});
  addA(t2,"m60",{foot_dragging:1,tremor:0,fatigue:1,dizziness:1},4,{dyskinesia:3});
  t2.finalEvaluation={overallEffect:"marked_effect",adverseEffectSummary:"tolerable",note:""};
  const cmp=CHG.compareTests(t,t2);
  ok(cmp.rows.some(r=>r.key==="firstPerceived") && cmp.rows.some(r=>r.key==="imp_motor"), "비교 표: 체감·그룹별 개선 포함");
  const notes=CHG.buildComparisonNotes(cmp);
  ok(notes.some(n=>n.includes("빨리 기록")), "허용 비교 문장: 더 빠른 체감");
  ok(notes.some(n=>n.includes("이상운동증 점수도 증가")), "허용 비교 문장: 개선+이상운동증 동반");
  ok(CHG.checkSafety({notes,rows:cmp.rows.map(r=>r.ko)}).length===0, "비교 결과 금지 표현 0건");
}
{ /* 금지 표현 검출력 */
  ok(CHG.checkSafety({x:"용량을 늘리는 것이 좋습니다"}).length===1, "금지: 증량 권고 감지");
  ok(CHG.checkSafety({x:"레보도파 반응 양성입니다"}).length===1, "금지: 레보도파 판정 감지");
  ok(CHG.checkSafety({x:"지금은 ON 상태입니다"}).length===1, "금지: ON 확정 감지");
  ok(CHG.checkSafety({x:CHG.DISCLAIMER, y:CHGSIM.DISCLAIMER_USE}).length===0, "면책문은 오탐 없음");
}

console.log("== 시뮬 모듈 ==");
{ const pts=CHGSIM.curvePts([{name:"퍼킨",dose:100,time:"07:00"}]);
  const peak=pts.reduce((b,p)=>p.val>b.val?p:b);
  ok(pts.length>0 && peak.val>0, "곡선 생성·양의 피크");
  ok(Math.abs(peak.t-(7*60+35))<=20, "퍼킨 피크가 복용+35분 부근("+(peak.t-420)+"분)");
  const rel=CHGSIM.relativeCurve([{name:"퍼킨",dose:100,time:"07:00"}],"07:00");
  ok(rel[0].t===-30 && rel[rel.length-1].t===150, "상대 곡선 -30~150분 축");
  const low=CHGSIM.relativeCurve([{name:"퍼킨",dose:50,time:"07:00"}],"07:00");
  const maxRel=a=>Math.max(...a.map(p=>p.val));
  ok(maxRel(rel)>maxRel(low), "용량 변경이 곡선 높이에 반영");
  ok(/혈중농도나 개인 반응을 직접 예측한 결과가 아닙니다/.test(CHGSIM.DISCLAIMER_MODEL), "시뮬 면책 문구");
}

console.log("== 타이머 모듈 ==");
{ const iso=new Date(Date.now()-70*60000).toISOString(); /* 70분 전 복용 */
  const info=CHGTIMER.dueInfo(iso, ["m30","m60"]);
  ok(info.elapsed>=69&&info.elapsed<=71, "경과 계산");
  ok(info.next && info.next.stage==="m90" && info.next.inMin<=20, "다음 예정 m90");
  const info2=CHGTIMER.dueInfo(iso, []);
  ok(info2.missed.some(m=>m.stage==="m30"), "놓친 기록 표시(m30, +15분 초과)");
  const iso2=new Date(Date.now()-60*60000).toISOString();
  ok(CHGTIMER.dueInfo(iso2,[]).missed.every(m=>m.minutes<60), "유예 15분 내 m60은 놓침 아님");
}

console.log("== 용량 추출·표기 ==");
{ const src=fs.readFileSync(path.join(ROOT,"index.html"),"utf-8");
  const fn=src.match(/function parseDoseMg[\s\S]*?\n}/)[0];
  const parseDoseMg=new Function("return ("+fn.replace("function parseDoseMg","function")+")")();
  ok(parseDoseMg("1정 (100mg)","100mg")===100, "'1정 (100mg)' → 100mg (mg 우선)");
  ok(parseDoseMg("1.5정","100mg")===150, "'1.5정'×함량 100mg → 150mg");
  ok(parseDoseMg("150mg","100mg")===150, "'150mg' 직접 표기");
  ok(parseDoseMg("","100mg")===100, "복용량 미입력 시 1정 함량 사용");
  const sim=fs.readFileSync(path.join(ROOT,"challenge-sim.js"),"utf-8");
  ok(sim.includes("온젠티스(오피카폰)")&&!sim.includes("온젠티스(엔타카폰)"), "온젠티스 성분명 오피카폰으로 정정");
  ok(sim.includes('n.includes("오피카폰")'), "오피카폰 검색 조건 추가");
  ok(CHGSIM.kineticFor("온젠티스(오피카폰)").type==="extend", "온젠티스 프로필 유지");
}

console.log("== v1 마이그레이션 ==");
{ const v1={version:1, settings:{language:"ko"}, tests:[{
    id:"abc", createdAt:"2026-07-27T07:00:00+09:00", status:"completed", testType:"current_regimen",
    title:"퍼킨 100mg", medication:{name:"퍼킨",dose:"100mg",dosageForm:"",scheduledTime:"07:00",doseTakenAt:"2026-07-27T07:02:00+09:00",additionalMedications:[],changeDescription:"기준 시험"},
    symptoms:[{code:"foot_dragging",customLabel:""},{code:"custom",customLabel:"목 뻐근함"}],
    assessments:[
      {stage:"baseline",scheduledMinutes:0,actualMinutes:0,recordedAt:"",symptomScores:{foot_dragging:3,custom:2},perceivedEffect:"uncertain",adverseEffects:[],note:""},
      {stage:"m60",scheduledMinutes:60,actualMinutes:64,recordedAt:"",symptomScores:{foot_dragging:1,custom:1},perceivedEffect:"clear",adverseEffects:[{code:"dizziness",severity:"severe"}],note:"메모"}],
    finalEvaluation:{overallEffect:"moderate_effect",adverseEffectSummary:"tolerable",note:""}}]};
  const res=CHG.migrateV1(v1);
  ok(res.ok && res.db2.tests.length===1 && res.db2.migratedFromV1, "v1 변환 성공");
  const t=res.db2.tests[0];
  ok(t.symptoms.every(s=>s.group==="motor"), "v1 증상 기본 운동 분류");
  ok(t.symptoms[1].code==="motor_custom" && t.symptoms[1].customLabel==="목 뻐근함", "v1 custom 증상 라벨 보존");
  const m60=t.assessments.find(a=>a.stage==="m60");
  ok(m60.perceivedScore===3 && m60.adverseScores.dizziness===4 && m60.actualMinutes===64, "체감·부작용 척도 변환(clear→3, severe→4)·실제시각 보존");
  ok(t.doseTakenAt==="2026-07-27T07:02:00+09:00", "복용 시각 ISO 보존");
  const a=CHG.analyzeTest(t);
  ok(a.groupSummary.motor.maxImprovement===1.5, "변환 데이터 분석 동작");
  ok(!CHG.migrateV1({version:3}).ok && !CHG.migrateV1(null).ok, "비정상 입력은 실패 반환(원본 유지 경로)");
}

console.log("== jsdom 통합 ==");
const {JSDOM}=require("jsdom");
const rawHtml=fs.readFileSync(path.join(ROOT,"index.html"),"utf-8");
function inline(html){
  return html
    .replace('<script src="challenge-engine.js"></script>', "<script>"+fs.readFileSync(path.join(ROOT,"challenge-engine.js"),"utf-8")+"<\/script>")
    .replace('<script src="challenge-sim.js"></script>', "<script>"+fs.readFileSync(path.join(ROOT,"challenge-sim.js"),"utf-8")+"<\/script>")
    .replace('<script src="challenge-timer.js"></script>', "<script>"+fs.readFileSync(path.join(ROOT,"challenge-timer.js"),"utf-8")+"<\/script>")
    .replace('<script src="challenge-report.js"></script>', "<script>"+fs.readFileSync(path.join(ROOT,"challenge-report.js"),"utf-8")+"<\/script>")
    .replace('<link rel="stylesheet" href="challenge.css">',"");
}
const html=inline(rawHtml);
const errs=[];
const dom=new JSDOM(html,{runScripts:"dangerously",url:"https://example.org/challenge/",
  beforeParse(w){ w.addEventListener("error",e=>errs.push(String(e.message))); w.confirm=()=>true; w.alert=()=>{}; }});
const w=dom.window, d=w.document;
const APP=()=>d.getElementById("app").textContent;
setTimeout(()=>{
  ok(errs.length===0, "로드 시 스크립트 오류 없음 ("+errs.join(";")+")");
  ok(w.CHG.STORAGE_KEY==="medicationChallengeDbV2" && w.CHG.MEDLIST_KEY==="medicationChallengeMedicationListV2", "v2 독립 저장 키 2종");
  ok(!rawHtml.includes("yakhyo"), "본체 코드 참조 없음");
  ok(APP().includes("증량·감량·추가를 권하는 기능이 아닙니다"), "첫 화면 안전 안내");
  /* 약 관리 CRUD */
  w.viewMeds(); w.editMed(null);
  d.getElementById("m_name").value="퍼킨"; d.getElementById("m_unit").value="100mg";
  d.getElementById("m_dose").value="100mg"; d.getElementById("m_times").value="07:00, 12:00";
  w.saveMed("");
  let ml=JSON.parse(w.localStorage.getItem(w.CHG.MEDLIST_KEY));
  ok(ml.meds.length===1 && ml.meds[0].usualTimes.join()==="07:00,12:00", "약 등록·시각 파싱");
  w.copyMed(ml.meds[0].id);
  ml=JSON.parse(w.localStorage.getItem(w.CHG.MEDLIST_KEY));
  ok(ml.meds.length===2, "약 복사");
  w.delMed(ml.meds[1].id);
  ok(JSON.parse(w.localStorage.getItem(w.CHG.MEDLIST_KEY)).meds.length===1, "약 삭제");
  /* 새 시험 마법사 */
  w.viewSetup();
  d.querySelector('#med_chips .chip').click();
  { const pd=w.eval("JSON.parse(JSON.stringify(wiz.plannedDoses))");
    ok(pd.length===1 && pd[0].name==="퍼킨" && pd[0].time==="07:00", "약 체크 → 복용안 프리필"); }
  ok(!!d.getElementById("simPreview").querySelector("svg"), "예상곡선 미리보기 표시");
  ok(d.getElementById("simPreview").textContent.includes("시뮬레이션"), "시뮬 면책 표시");
  d.querySelector('.sy_grp[data-group="motor"] .chip[data-k="foot_dragging"]').click();
  d.querySelector('.sy_grp[data-group="motor"] .chip[data-k="tremor"]').click();
  d.querySelector('.sy_grp[data-group="nonmotor"] .chip[data-k="fatigue"]').click();
  d.querySelector('.sy_grp[data-group="autonomic"] .chip[data-k="dizziness"]').click();
  d.getElementById("chg_desc").value="기준 시험";
  w.startTest();
  let saved=JSON.parse(w.localStorage.getItem(w.CHG.STORAGE_KEY));
  ok(saved.tests.length===1 && saved.tests[0].symptoms.length===4, "시험 생성(3그룹 증상 4개)");
  ok(saved.tests[0].symptoms.map(s=>s.group).sort().join()==="autonomic,motor,motor,nonmotor", "증상 그룹 코드 저장");
  /* 복용 전 기록 */
  d.querySelectorAll('.scorerow[data-sy]').forEach(row=>row.querySelector('.scorebtn[data-v="3"]').click());
  d.querySelector('#pe_row .scorebtn[data-v="0"]').click();
  d.getElementById("as_save").click();
  /* 복용 → 30분 기록 (부작용 3점 경고) */
  w.markDose();
  d.querySelectorAll('.scorerow[data-sy]').forEach(row=>row.querySelector('.scorebtn[data-v="2"]').click());
  d.querySelector('#pe_row .scorebtn[data-v="2"]').click();
  d.querySelector('.aerow[data-ae="dyskinesia"] .aebtn[data-v="3"]').click();
  ok(d.getElementById("ae_warn").textContent.includes("테스트를 중단하고"), "부작용 3점 중단 안내");
  d.getElementById("as_save").click();
  saved=JSON.parse(w.localStorage.getItem(w.CHG.STORAGE_KEY));
  const m30=saved.tests[0].assessments.find(a=>a.stage==="m30");
  ok(m30 && typeof m30.actualMinutes==="number" && m30.adverseScores.dyskinesia===3 && m30.perceivedScore===2, "30분 기록(실제 시각·부작용 점수·체감 점수)");
  ok(/T.*Z|[+-]\d{2}:\d{2}/.test(saved.tests[0].doseTakenAt), "복용 시각 ISO 저장(자정 안전)");
  ok(w.eval("CHGTIMER._timers.length")>0, "복용 직후 타이머 즉시 예약("+"타이머 "+"개수>0)");
  { const m=w.eval(`(function(){ const t=db.tests.find(x=>x.status==="in_progress");
      const bak=t.doseTakenAt; t.doseTakenAt=new Date(Date.now()-60*60000).toISOString();
      const v=CHGTIMER.elapsedMin(t.doseTakenAt); t.doseTakenAt=bak; return v; })()`);
    ok(m>=59&&m<=61, "자정 무관 경과분 계산("+m+"분)"); }
  /* 60분 건너뛰기 → 조기 종료 */
  d.getElementById("as_skip").click();
  w.viewFinish();
  d.querySelector('#fe_overall .chip[data-k="moderate_effect"]').click();
  d.querySelector('#fe_ae .chip[data-k="tolerable"]').click();
  w.saveFinal();
  saved=JSON.parse(w.localStorage.getItem(w.CHG.STORAGE_KEY));
  ok(saved.tests[0].status==="completed", "조기 종료·최종 평가");
  ok(d.querySelectorAll("#app svg").length>=2, "결과: 예상+실제 SVG 동시 표시");
  ok(APP().includes("혈중농도")&&APP().includes("진단이나 치료 결정을 대신하지 않습니다"), "결과 면책 2종");
  ok(!/용량을 늘리|용량을 줄이|더 적절합니다|반응 양성|반응 음성|치료가 성공|치료가 실패/.test(APP()), "결과 화면 권고·판정 문구 0건");
  /* 변경 시험 주입 → 비교 */
  const t2id=w.eval(`(function(){
    const t2=CHG.newTest({testType:"dose_changed", comparisonRole:"changed", title:"퍼킨 150mg",
      plannedDoses:[{name:"퍼킨",dose:150,time:"07:00"}],
      medications:[{name:"퍼킨",doseText:"150mg"}], changeDescription:"의사와 상의 후 변경",
      symptoms:[{code:"foot_dragging",group:"motor",customLabel:""},{code:"tremor",group:"motor",customLabel:""},{code:"fatigue",group:"nonmotor",customLabel:""},{code:"dizziness",group:"autonomic",customLabel:""}]});
    [["baseline",3,0],["m30",1,3],["m60",1,4]].forEach(([st,v,pe])=>
      t2.assessments.push({stage:st,scheduledMinutes:0,actualMinutes:0,recordedAt:"",
        symptomScores:{foot_dragging:v,tremor:v,fatigue:2,dizziness:1},perceivedScore:pe,adverseScores:{},note:""}));
    t2.status="completed"; t2.finalEvaluation={overallEffect:"marked_effect",adverseEffectSummary:"none",note:""};
    db.tests.push(t2); save(); return t2.id; })()`);
  w.viewCompare(saved.tests[0].id, t2id);
  ok(APP().includes("기준 시험")&&APP().includes("변경 시험")&&d.querySelectorAll("#app svg").length>=2, "비교 화면: 예상+실제 이중 그래프");
  ok(APP().includes("더 큰 점수 감소가 기록"), "비교 허용 문장 표시(운동 개선 차이)");
  /* 백업 왕복 */
  const backup=w.eval(`JSON.stringify({app:"medication-challenge",version:2,db,medList})`);
  w.eval("db=CHG.emptyDb(); save(); medList=CHG.emptyMedList(); saveMeds();");
  w.eval(`(function(){ const d=JSON.parse(${JSON.stringify(backup)}); db=d.db; save(); medList=d.medList; saveMeds(); })()`);
  ok(JSON.parse(w.localStorage.getItem(w.CHG.STORAGE_KEY)).tests.length===2 && JSON.parse(w.localStorage.getItem(w.CHG.MEDLIST_KEY)).meds.length===1, "백업 JSON 왕복(테스트+약 목록)");
  /* v1 자동 마이그레이션 */
  const v1raw=JSON.stringify({version:1,settings:{language:"ko"},tests:[{id:"x1",createdAt:"2026-07-27T07:00:00+09:00",status:"completed",testType:"current_regimen",title:"퍼킨 100mg",
    medication:{name:"퍼킨",dose:"100mg",scheduledTime:"07:00",doseTakenAt:"2026-07-27T07:01:00+09:00",changeDescription:"기준 시험"},
    symptoms:[{code:"foot_dragging",customLabel:""}],
    assessments:[{stage:"baseline",scheduledMinutes:0,actualMinutes:0,recordedAt:"",symptomScores:{foot_dragging:3},perceivedEffect:"uncertain",adverseEffects:[],note:""},
                 {stage:"m60",scheduledMinutes:60,actualMinutes:60,recordedAt:"",symptomScores:{foot_dragging:1},perceivedEffect:"clear",adverseEffects:[{code:"dizziness",severity:"mild"}],note:""}],
    finalEvaluation:{overallEffect:"moderate_effect",adverseEffectSummary:"tolerable",note:""}}]});
  const dom2=new JSDOM(html,{runScripts:"dangerously",url:"https://example.org/challenge/",
    beforeParse(w2){ w2.localStorage.setItem("medicationChallengeDbV1", v1raw); w2.confirm=()=>true; w2.alert=()=>{}; }});
  setTimeout(()=>{
    const w2=dom2.window;
    ok(w2.eval("db.tests.length")===1 && w2.eval("db.migratedFromV1")===true, "v1 자동 감지·변환");
    ok(w2.localStorage.getItem("medicationChallengeDbV1")===v1raw, "v1 원본 키 보존");
    ok(w2.localStorage.getItem("medicationChallengeDbV1Backup")===v1raw, "v1 백업 사본 생성");
    ok(w2.document.getElementById("app").textContent.includes("가져왔어요"), "마이그레이션 안내 표시");
    /* 재실행 복원 */
    const cur=w.eval(`JSON.stringify(db)`);
    const dom3=new JSDOM(html,{runScripts:"dangerously",url:"https://example.org/challenge/",
      beforeParse(w3){ w3.localStorage.setItem("medicationChallengeDbV2", cur); w3.confirm=()=>true; w3.alert=()=>{}; }});
    setTimeout(()=>{
      ok(dom3.window.eval("db.tests.length")===2, "브라우저 재실행 후 v2 데이터 복원");
      const css=fs.readFileSync(path.join(ROOT,"challenge.css"),"utf-8");
      ok(/user-scalable=yes/.test(rawHtml)&&/maximum-scale=5\.0/.test(rawHtml), "확대 허용 viewport");
      ok(/min-height:48px|min-height:52px/.test(css)&&/min-height:44px/.test(css), "터치 영역 확보(점수 52·부작용 44px)");
      ok(/@page\{ size:A4; margin:12mm \}/.test(css)&&/break-inside:avoid/.test(css), "A4 인쇄·잘림 방지 CSS");
      const sw=fs.readFileSync(path.join(ROOT,"sw.js"),"utf-8");
      ok(/medication-challenge-v2/.test(sw)&&/challenge-sim\.js/.test(sw)&&/icon-192\.png/.test(sw), "SW 캐시 v2·에셋(아이콘 포함) 갱신");
      const mf=JSON.parse(fs.readFileSync(path.join(ROOT,"manifest.json"),"utf-8"));
      ok(mf.icons.every(i=>i.src.startsWith("./icon-"))&&fs.existsSync(path.join(ROOT,"icon-192.png"))&&fs.existsSync(path.join(ROOT,"icon-512.png")), "PWA 아이콘 동봉·상대경로");
      ok(fs.readFileSync(path.join(ROOT,"index.html"),"utf-8").includes("낮을수록 좋습니다"), "그래프 방향 설명 문구");
      console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
      process.exit(fail?1:0);
    },300);
  },300);
},400);
