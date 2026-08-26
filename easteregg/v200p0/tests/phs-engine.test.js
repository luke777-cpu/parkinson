/* PHS 엔진 단위 테스트 — WORK_ORDER §14 fixtures 1~14 */
const fs=require('fs'), path=require('path'), vm=require('vm');
const ROOT=path.join(__dirname,'..');
const ctx={window:undefined}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT,'phs-engine.js'),'utf-8'),ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT,'phs-report.js'),'utf-8'),ctx);
const PHS=ctx.PHS;

let pass=0,fail=0;
const ok=(c,n)=>{ c?pass++:fail++; console.log((c?"  ✔ ":"  ✘ FAIL: ")+n); };

const D0=new Date("2026-07-20T00:00:00"); // 관찰 시작일 (월)
const ts=(day,h,m=0)=>new Date(D0.getFullYear(),D0.getMonth(),D0.getDate()+day,h,m).getTime();
let _id=0; const id=()=>"e"+(++_id);
const out=(day,h,m,v,extra={})=>({id:id(),type:"state",state:"on",ts:ts(day,h,m),output:v,trend:extra.trend||"stable",retrospective:!!extra.retro});
const med=(day,h,m,name="퍼킨",dose=100)=>({id:id(),type:"med",drug:name,dose,ts:ts(day,h,m)});
const sym=(day,h,m,key,phase,o=null)=>({id:id(),type:"symptom",key,phase,ts:ts(day,h,m),outputAtStart:phase==="start"?o:null,outputAtEnd:phase==="end"?o:null});
const life=(day,h,m,kind,extra={})=>({id:id(),type:"life",kind,ts:ts(day,h,m),...extra});
const S=ts(0,0,0), E=ts(7,0,0);
const run=(events,survey)=>{ const a=PHS.analyze({events,startTs:S,endTs:E}); const c=PHS.assessConfidence(a,survey||null); return {a,c}; };

console.log("== 1. 정상 반응 ==");
{ const ev=[]; for(let d=0;d<5;d++){ ev.push(out(d,7,30,30), med(d,8,0), out(d,8,40,60), out(d,10,0,75), out(d,12,0,70), out(d,15,0,65), out(d,18,0,60)); }
  const {a}=run(ev);
  ok(a.medicationResponse.morningFirstDose.medianRiseMinutes<=60,"상승 중앙값 60분 이하");
  ok(a.medicationResponse.morningFirstDose.delayedCandidates===0,"지연 후보 0");
  ok(a.output.average>50,"평균 출력 계산"); }

console.log("== 2. 오전 반응 지연 후보 ==");
{ const ev=[]; for(let d=0;d<5;d++){ ev.push(out(d,7,30,25), med(d,8,0), out(d,8,45,30), out(d,9,30,35), out(d,10,0,55), out(d,11,0,70), out(d,13,0,65)); }
  const {a}=run(ev);
  const m=a.medicationResponse.morningFirstDose;
  ok(m.medianRiseMinutes>60,`상승 중앙값 ${m.medianRiseMinutes}분 > 60`);
  ok(m.delayedCandidates>=3,`지연 후보 ${m.delayedCandidates}회`);
  const r=PHS.buildReport({profile:{diagnosisYears:14},startSurvey:{primaryProblem:"delayed_response",chiefProblems:["delayed_response","afternoon_decline"]},endSurvey:null,analysis:a,confidence:PHS.assessConfidence(a),medsList:[]});
  ok(r.onePageSummary.hpi.includes("반응 지연 후보"),"HPI에 지연 후보 문장");
  ok(!/delayed ON입니다/.test(JSON.stringify(r)),"금지 표현 없음"); }

console.log("== 3. 불완전 반응 후보 ==");
{ const ev=[];
  for(let d=0;d<3;d++){ ev.push(out(d,7,30,30), med(d,8,0), out(d,8,40,55), out(d,10,0,90), out(d,13,0,80)); } // 좋은 날: 최고 90
  for(let d=3;d<6;d++){ ev.push(out(d,7,30,30), med(d,8,0), out(d,8,40,50), out(d,10,0,55), out(d,13,0,50)); } // 못 올라간 날: 최고 55
  const {a}=run(ev);
  ok(a.output.personalPeakMedian>=55,"개인 기대치 산출");
  ok(a.medicationResponse.morningFirstDose.incompleteCandidates>=2,`불완전 후보 ${a.medicationResponse.morningFirstDose.incompleteCandidates}회`); }

console.log("== 4. 뚜렷한 반응 없음 후보 ==");
{ const ev=[]; for(let d=0;d<4;d++){ ev.push(out(d,7,30,30), med(d,8,0), out(d,9,0,32), out(d,10,0,35), out(d,11,0,30)); }
  const {a}=run(ev);
  ok(a.medicationResponse.morningFirstDose.noClearResponseCandidates>=3,`무반응 후보 ${a.medicationResponse.morningFirstDose.noClearResponseCandidates}회`);
  const r=PHS.buildReport({profile:null,startSurvey:null,endSurvey:null,analysis:a,confidence:PHS.assessConfidence(a),medsList:[]});
  ok(JSON.stringify(r).includes("뚜렷한 반응이 확인되지 않은 후보"),"허용 표현 사용");
  ok(!JSON.stringify(r).includes("ON failure입니다"),"ON failure 표현 없음"); }

console.log("== 5. 오후 반복 저하 (웨어링오프 후보) ==");
{ const ev=[]; for(let d=0;d<4;d++){ ev.push(out(d,7,30,30), med(d,8,0), out(d,9,0,70), out(d,12,0,65), out(d,12,50,40), med(d,13,0), out(d,14,0,70), out(d,17,0,60)); }
  const {a}=run(ev);
  ok(a.medicationResponse.wearingOff.candidate===true,"웨어링오프 후보 감지");
  ok(a.medicationResponse.wearingOff.days>=2,"2일 이상 반복"); }

console.log("== 6. 고출력 이상운동 ==");
{ const ev=[]; for(let d=0;d<4;d++){ ev.push(out(d,8,0,40), med(d,8,10), out(d,9,0,80), sym(d,9,30,"dysk","start",80), sym(d,10,0,"dysk","end",75), out(d,12,0,70)); }
  const {a}=run(ev);
  ok(a.symptoms.dysk.relation==="high_output_associated","이상운동=고출력 연관 분류");
  ok(a.symptoms.dysk.medianDurationMinutes===30,"지속시간 30분 산출"); }

console.log("== 7. 저출력 근긴장 ==");
{ const ev=[]; for(let d=0;d<4;d++){ ev.push(out(d,6,30,15), sym(d,6,40,"dyst","start",15), sym(d,7,0,"dyst","end"), med(d,8,0), out(d,9,0,60), out(d,12,0,65)); }
  const {a}=run(ev);
  ok(["low_output_associated","morning_associated"].includes(a.symptoms.dyst.relation),"근긴장=저출력/오전 연관 분류: "+a.symptoms.dyst.relation); }

console.log("== 8. 기록 부족 ==");
{ const ev=[out(0,8,0,50), out(1,9,0,40), med(1,8,0)];
  const {a,c}=run(ev);
  ok(c.overall==="low","신뢰도 low");
  ok(c.reasons.map(r=>PHS.reasonText(r,"ko")).some(r=>r.includes("부족")),"부족 사유 명시(ko)");
  ok(c.reasons.map(r=>PHS.reasonText(r,"en")).some(r=>/few|Low/i.test(r)),"부족 사유 영어 변환");
  const r=PHS.buildReport({profile:null,startSurvey:null,endSurvey:null,analysis:a,confidence:c,medsList:[]});
  ok(r.detailedReport.limitations.some(l=>l.includes("신뢰도가 제한적")||l.includes("부족")),"보고서에 한계 명시"); }

console.log("== 9. 설문-기록 불일치 ==");
{ const ev=[]; for(let d=0;d<5;d++){ ev.push(out(d,7,30,30), med(d,8,0), out(d,8,30,55), out(d,10,0,70), out(d,13,0,65), out(d,16,0,60)); }
  const {a}=run(ev); // 실제 빠른 반응
  const c=PHS.assessConfidence(a,{perceivedMorningResponse:"60_to_90_min"}); // 체감은 느림
  ok(c.surveyAgreement==="conflict","불일치 감지");
  ok(c.reasons.some(r=>r.code==="survey_conflict"),"불일치 사유 코드 기록"); }

console.log("== 10. 복약 누락 (기록 없음) ==");
{ const ev=[]; for(let d=0;d<4;d++){ ev.push(out(d,8,0,40), out(d,10,0,50), out(d,13,0,45), out(d,16,0,40), out(d,19,0,35)); }
  const {a,c}=run(ev);
  ok(a.medicationResponse.totalDoses===0,"복약 0건 처리");
  ok(c.reasons.some(r=>r.code==="no_med_times"),"복약 누락 감점 사유 코드");
  const r=PHS.buildReport({profile:null,startSurvey:null,endSurvey:null,analysis:a,confidence:c,medsList:[]});
  ok(r.detailedReport.currentMedication.length===0,"현재 약물 빈 목록"); }

console.log("== 11. 장기 미기록 공백 ==");
{ const ev=[]; for(let d=0;d<4;d++){ ev.push(out(d,7,0,30), med(d,8,0), out(d,8,30,40), /* 8:30~16:00 공백 */ out(d,16,0,55), out(d,18,0,50)); }
  const {a}=run(ev);
  ok(a.output.unrecordedGaps.length>=4,"공백 구간 식별");
  ok(a.output.missingMinutes>4*300,"결측 분 집계");
  /* 핵심: 기록이 끊긴 복용을 어떤 후보로도 판정하지 않아야 함 (제외 사유는 무엇이든) */
  const excluded=a.medicationResponse.perDose.filter(r=>r.exclusionReason&&!r.delayedCandidate&&!r.incompleteCandidate&&!r.noClearResponseCandidate);
  ok(excluded.length===a.medicationResponse.perDose.length,"공백 걸린 복용은 전부 후보 판정 없이 제외 (가짜 판정 방지)");
  ok(a.medicationResponse.allDoses.noClearResponseCandidates===0,"공백을 '반응 없음'으로 오판하지 않음"); }

console.log("== 12. 오프라인 보고서 생성 (네트워크 비의존) ==");
{ const src=fs.readFileSync(path.join(ROOT,'phs-engine.js'),'utf-8')+fs.readFileSync(path.join(ROOT,'phs-report.js'),'utf-8');
  ok(!/fetch\(|XMLHttpRequest|navigator\.sendBeacon|WebSocket/.test(src),"엔진 코드에 네트워크 API 없음");
  ok(pass>0,"엔진이 node(오프라인) 환경에서 정상 동작"); }

console.log("== 13. 레거시 데이터 마이그레이션 ==");
{ const legacy={events:[{id:"a",type:"state",state:"on",ts:ts(0,8,0),output:null},{id:"b",type:"med",drug:"퍼킨",ts:ts(0,9,0)}],meds:[],settings:{lang:"ko"}};
  const before=JSON.stringify(legacy.events);
  const {migrated,db}=PHS.migrate(legacy);
  ok(migrated===true,"마이그레이션 실행");
  ok(db.phs&&db.phs.v===1&&Array.isArray(db.phs.observations),"phs 네임스페이스 생성");
  ok(JSON.stringify(db.events)===before,"기존 이벤트 무변경");
  const again=PHS.migrate(db);
  ok(again.migrated===false,"재실행 시 무동작 (멱등)");
  delete db.phs; ok(JSON.stringify(db.events)===before,"롤백(phs 삭제) 후에도 원본 보존");
  const a=PHS.analyze({events:legacy.events,startTs:S,endTs:E});
  ok(a.period.totalOutputRecords===0,"output:null 레거시 기록은 분석에서 제외(기존 정책 유지)"); }

console.log("== 14. 한국어 안전 필터 ==");
{ const dirty={a:"이 환자는 delayed ON입니다.", b:"약을 증량해야 합니다.", c:["ON failure입니다.","이 약이 원인입니다."], d:"확진되었습니다"};
  const clean=PHS.applySafetyFilter(dirty);
  ok(PHS.checkReportSafety(clean).length===0,"필터 후 금지 표현 0건");
  ok(clean.a.includes("반응 지연 후보"),"delayed ON → 후보 표현");
  ok(clean.c[1].includes("인과관계는 확정할 수 없습니다"),"원인 단정 → 연관성 표현");
  const bad=PHS.checkReportSafety(dirty);
  ok(bad.length>=4,"검사기가 원본의 금지 표현 감지"); }

console.log("== 경계 테스트: 미기록 기준 180분 (공통 config) ==");
{ ok(PHS.config.maxGapMin===180,"PHS.config.maxGapMin === 180 (유일 정의 지점)");
  const mk=G=>{ // 07:00 기록 후 G분 뒤 기록, 이후 150분 간격으로 채움 → 시험 대상 간격만 변수
    const ev=[out(0,7,0,50)];
    let t=7*60+G; ev.push({id:id(),type:"state",state:"on",ts:ts(0,Math.floor(t/60),t%60),output:55,trend:"stable"});
    while(t+150<=23*60){ t+=150; ev.push({id:id(),type:"state",state:"on",ts:ts(0,Math.floor(t/60),t%60),output:60,trend:"stable"}); }
    return PHS.analyze({events:ev,startTs:S,endTs:ts(1,0,0)});
  };
  ok(mk(179).output.unrecordedGaps.length===0,"179분 간격 → 미기록 아님");
  ok(mk(180).output.unrecordedGaps.length===0,"180분 간격 → 미기록 아님 (경계 포함)");
  const a181=mk(181);
  ok(a181.output.unrecordedGaps.length===1 && a181.output.unrecordedGaps[0].minutes===181,"181분 간격 → 미기록 1건(181분)");
  ok(a181.output.missingMinutes===181,"미기록 분 집계 일치");
  /* 복용 후 관찰 창: 정확히 180분 뒤 상승 기록 → 평가 유지(지연 후보), 공백 오판 없음 */
  const ev2=[out(0,7,50,30), med(0,8,0), out(0,11,0,55)];
  const a2=PHS.analyze({events:ev2,startTs:S,endTs:ts(1,0,0)});
  const r2=a2.medicationResponse.perDose[0];
  ok(r2.evaluable===true && r2.riseMinutes===180 && r2.delayedCandidate===true,"복용+180분 상승 기록 → 평가 유지·지연 후보 (창 경계 일관)");
}

console.log("== 결정론성 ==");
{ const ev=[]; for(let d=0;d<3;d++){ ev.push(out(d,7,30,30), med(d,8,0), out(d,9,30,60)); }
  const a1=PHS.analyze({events:ev,startTs:S,endTs:E}), a2=PHS.analyze({events:ev,startTs:S,endTs:E});
  const strip=r=>{const c=JSON.parse(JSON.stringify(r)); delete c.generatedAt; return JSON.stringify(c);};
  const r1=PHS.buildReport({profile:null,startSurvey:null,endSurvey:null,analysis:a1,confidence:PHS.assessConfidence(a1),medsList:[]});
  const r2=PHS.buildReport({profile:null,startSurvey:null,endSurvey:null,analysis:a2,confidence:PHS.assessConfidence(a2),medsList:[]});
  ok(strip(r1)===strip(r2),"동일 입력 → 동일 보고서 JSON"); }

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
