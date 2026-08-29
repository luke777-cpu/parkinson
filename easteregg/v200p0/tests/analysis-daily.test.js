/* analysis-daily.test.js — Phase 6(SIMDAY) 회귀 테스트.
 * 엔진 파일(analysis-daily.js)은 DOM 무의존이므로 Node에서 require만으로 테스트한다.
 * 시나리오는 설계도(치료구간 설계도 Phase 6·7) 부록의 2026-08-29 실측 데이터를 그대로 쓴다. */
const path=require("path");
const DM=require(path.join(__dirname,"..","simulation-drugmodel.js"));
const CLIN=require(path.join(__dirname,"..","analysis-clinical.js"));
const DAY=require(path.join(__dirname,"..","analysis-daily.js"));

let pass=0, fail=0;
const ok=(c,n)=>{ c?pass++:fail++; console.log((c?"  ✔ ":"  ✘ FAIL: ")+n); };
const toMin=(h,m)=>h*60+m;

/* ---- 부록 데이터: 2026-08-29 실측 시나리오 ---- */
const doses=[
  {name:"온젠티스", dose:50, time:"22:00", dayOffset:-1},
  {name:"마도파 HBS", dose:100, time:"06:00", dayOffset:0},
  {name:"미라펙스ER", dose:0.375, time:"06:00", dayOffset:0},
  {name:"아만타딘", dose:100, time:"06:00", dayOffset:0},
  {name:"퍼킨", dose:100, time:"11:00", dayOffset:0},
  {name:"아질렉트", dose:1, time:"11:00", dayOffset:0},
  {name:"시네메트 CR", dose:100, time:"16:00", dayOffset:0},
  {name:"아만타딘", dose:100, time:"16:00", dayOffset:0},
];
const outputChecks=[
  [6,0,30],[8,0,40],[8,30,55],[9,0,90],[10,0,70],[10,35,55],[11,0,50],
  [12,0,70],[12,14,95],[14,0,100],[14,40,85],[16,0,50],[17,30,55],[18,20,90],[19,0,75],[20,0,90],
].map(([h,m,v])=>({timeMin:toMin(h,m), val:v}));
const events=[
  {timeMin:toMin(9,0), kind:"dysk", phase:"start"}, {timeMin:toMin(9,30), kind:"dysk", phase:"end"},
  {timeMin:toMin(12,0), kind:"dysk", phase:"start"}, {timeMin:toMin(12,14), kind:"dysk", phase:"end"},
  {timeMin:toMin(14,0), kind:"dysk", phase:"start"}, {timeMin:toMin(14,40), kind:"dysk", phase:"end"},
  {timeMin:toMin(18,0), kind:"dysk", phase:"start"}, {timeMin:toMin(18,20), kind:"dysk", phase:"end"},
];

console.log("== A. 부록 시나리오 스냅샷 (하한 역치 1.0 가정) ==");
{
  const res=DAY.dailyResiduals({doses, outputChecks, events, thresholds:{lower:1.0}});
  ok(res.valid===true, "valid:true");
  ok(res.reasons.length===0, "네 지표 모두 계산돼 reasons 비어있음: "+JSON.stringify(res.reasons));
  ok(res.onsetDelayMin===90, "①도달 지연 90분(실측 09:00 유효ON − 예측 07:30): "+res.onsetDelayMin);
  ok(res.peakResidual.timeDeltaMin===70, "②피크 잔차 +70분(실측 09:00 − 예측 07:50): "+res.peakResidual.timeDeltaMin);
  ok(res.peakResidual.overflow===true, "②overflow: 그 날 이상운동 사건 존재 → true");
  ok(res.earlyFadeMin===-20, "③earlyFadeMin -20(예측 하강 09:40이 실측 하강 10:00보다 먼저 — 이 시나리오에서는 예측이 더 일찍 꺼짐): "+res.earlyFadeMin);
  ok(res.troughs.length===3, "④골 3개(06:00/11:00/16:00, 이월된 22:00분은 제외): "+res.troughs.length);
  ok(res.troughs[0].beforeDoseTime==="06:00" && res.troughs[0].output===30, "06:00 골 = 30 (그 창의 유일한 실측점)");
  ok(res.troughs[1].beforeDoseTime==="11:00" && res.troughs[1].output===50, "11:00 골 = 50 (10:00→70,10:35→55,11:00→50 중 최저)");
  ok(res.troughs[2].beforeDoseTime==="16:00" && res.troughs[2].output===50, "16:00 골 = 50 (그 창의 유일한 실측점)");
  ok(res.samples.primaryDose && res.samples.primaryDose.name==="마도파 HBS", "samples.primaryDose = 그 날 첫 direct_curve 복용(마도파 HBS 06:00)");
  ok(res.samples.doseCount===8 && res.samples.outputCheckCount===16 && res.samples.dyskEventCount===8, "samples 원자료 개수 검증용 요약(dyskEventCount는 start+end 각각 셈): "+res.samples.doseCount+","+res.samples.outputCheckCount+","+res.samples.dyskEventCount);
}

console.log("\n== B. 역치 미성립(하한 없음) → 관련 지표 null + reasons 채워짐 ==");
{
  const res=DAY.dailyResiduals({doses, outputChecks, events, thresholds:{}});
  ok(res.valid===true, "복용·출력 기록 자체는 있으므로 valid:true (개별 지표만 null)");
  ok(res.onsetDelayMin===null, "하한 없으면 도달 지연 계산 불가 → null");
  ok(res.reasons.some(r=>r.includes("하한")), "reasons에 하한 부재 사유 포함: "+JSON.stringify(res.reasons));
  ok(res.earlyFadeMin===null, "하한 없으면 예측 하강 시각도 없어 조기 소진도 null");
  ok(res.peakResidual.timeDeltaMin===70, "피크 잔차는 하한과 무관해 그대로 계산됨: "+res.peakResidual.timeDeltaMin);
  ok(res.troughs.length===3, "골 깊이도 하한과 무관해 그대로 계산됨");
}

console.log("\n== C. 복용 기록 자체가 없는 날 → valid:false ==");
{
  const res=DAY.dailyResiduals({doses:[], outputChecks, events, thresholds:{lower:1.0}});
  ok(res.valid===false, "그 날 복용 기록이 없으면 valid:false");
  ok(res.reasons.length>0, "사유 기록됨: "+JSON.stringify(res.reasons));
  ok(res.onsetDelayMin===null && res.peakResidual.timeDeltaMin===null && res.earlyFadeMin===null && res.troughs.length===0,
    "복용 기록 없으면 모든 지표가 null/빈 배열");
}

console.log("\n== D. 출력 기록이 아예 없는 날 → 실측 관련 지표만 null, 예측 관련은 계산됨 ==");
{
  const res=DAY.dailyResiduals({doses, outputChecks:[], events:[], thresholds:{lower:1.0}});
  ok(res.valid===true, "복용 기록은 있으므로 valid:true");
  ok(res.onsetDelayMin===null, "실측 유효 ON 도달이 없어 도달 지연도 null");
  ok(res.peakResidual.timeDeltaMin===null, "실측 출력이 없어 피크 잔차도 null");
  ok(res.peakResidual.overflow===false, "이상운동 사건도 없으므로 overflow:false");
  ok(res.troughs.length===0, "실측이 전혀 없으니 골도 0개");
}

console.log("\n== E. SIMDAY.aggregate — 표본 부족(2건) → valid:false ==");
{
  const dayA=DAY.dailyResiduals({doses, outputChecks, events, thresholds:{lower:1.0}});
  const dayB=DAY.dailyResiduals({doses, outputChecks, events, thresholds:{lower:1.0}});
  const agg=DAY.aggregate([dayA, dayB]);
  ok(agg.valid===false, "유효한 날이 2건뿐이면 valid:false: "+JSON.stringify(agg));
  ok(agg.n===2, "n=2 보고");
}

console.log("\n== F. SIMDAY.aggregate — 표본 3건 이상 → 지표별 중앙값·표본수 ==");
{
  const dayA=DAY.dailyResiduals({doses, outputChecks, events, thresholds:{lower:1.0}});
  const dayB=DAY.dailyResiduals({doses, outputChecks, events, thresholds:{lower:1.0}});
  const dayC=DAY.dailyResiduals({doses, outputChecks, events, thresholds:{lower:1.0}});
  const agg=DAY.aggregate([dayA, dayB, dayC]);
  ok(agg.valid===true, "3건 이상 → valid:true");
  ok(agg.n===3, "n=3");
  ok(agg.onsetDelayMin.median===90 && agg.onsetDelayMin.n===3, "onsetDelayMin 중앙값·표본수: "+JSON.stringify(agg.onsetDelayMin));
  ok(agg.peakTimeDeltaMin.median===70 && agg.peakTimeDeltaMin.n===3, "peakTimeDeltaMin 중앙값·표본수: "+JSON.stringify(agg.peakTimeDeltaMin));
  ok(agg.overflowDays===3, "overflowDays: 3일 모두 이상운동 사건 있음");
  ok(agg.earlyFadeMin.median===-20 && agg.earlyFadeMin.n===3, "earlyFadeMin 중앙값·표본수: "+JSON.stringify(agg.earlyFadeMin));
  ok(agg.troughOutput.n===9, "troughOutput.n = 3일×3골 = 9: "+agg.troughOutput.n);
  ok(agg.troughOutput.median===50, "troughOutput.median: "+agg.troughOutput.median);
}

console.log("\n== G. 결측 지표가 섞인 날들의 aggregate — 지표별로 독립적으로 표본을 모음 ==");
{
  const full=DAY.dailyResiduals({doses, outputChecks, events, thresholds:{lower:1.0}});
  const noThreshold=DAY.dailyResiduals({doses, outputChecks, events, thresholds:{}}); // onsetDelayMin/earlyFadeMin만 null, valid는 true
  const third=DAY.dailyResiduals({doses, outputChecks, events, thresholds:{lower:1.0}});
  const agg=DAY.aggregate([full, noThreshold, third]);
  ok(agg.valid===true, "3일 모두 valid:true(개별 지표 결측과 무관)");
  ok(agg.onsetDelayMin.n===2, "onsetDelayMin은 계산 가능했던 2일만 표본에 포함: "+agg.onsetDelayMin.n);
  ok(agg.peakTimeDeltaMin.n===3, "peakTimeDeltaMin은 하한과 무관해 3일 모두 포함: "+agg.peakTimeDeltaMin.n);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
