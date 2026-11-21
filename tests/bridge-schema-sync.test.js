/* 원격 공유 허용 값 목록이 네 곳에서 같은지 대조한다.
 *   supabase/migrations/*_diary_bridge.sql (DB 검증), workers/mcp/src/schema.ts (MCP 도구),
 *   cloud-bridge.js (브라우저 변환), index.html (앱 원본 상수)
 * 앱에 값이 추가되면 이 테스트가 실패해 세 곳을 함께 고치도록 알린다(drug-dictionary 동기 검사와 같은 취지). */
const fs=require('fs'), path=require('path');
const ROOT=path.join(__dirname,'..');
const sql=fs.readdirSync(path.join(ROOT,'supabase/migrations')).filter(f=>f.endsWith('_diary_bridge.sql')).map(f=>fs.readFileSync(path.join(ROOT,'supabase/migrations',f),'utf8')).join("\n");
const ts=fs.readFileSync(path.join(ROOT,'workers/mcp/src/schema.ts'),'utf8');
const js=fs.readFileSync(path.join(ROOT,'cloud-bridge.js'),'utf8');
const app=fs.readFileSync(path.join(ROOT,'index.html'),'utf8');

let pass=0, fail=0;
const ok=(c,n)=>{ c?pass++:fail++; console.log((c?"  ✔ ":"  ✘ FAIL: ")+n); };
const parseArr=(src)=>JSON.parse("["+src.replace(/'/g,'"').replace(/,\s*$/,"")+"]");
function fromTs(name){ const m=new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const`).exec(ts); return m && parseArr(m[1]); }
function fromJs(name){ const m=new RegExp(`${name}: \\[([^\\]]*)\\]`).exec(js); return m && parseArr(m[1]); }
function fromApp(name){ const m=new RegExp(`const ${name} = \\[([^\\]]*)\\];`).exec(app); return m && parseArr(m[1]); }
const sqlArray=(vals)=>"array["+vals.map(v=>`'${v}'`).join(",")+"]";

const NAMES=["STATE_VALUES","TREND_VALUES","SYMPTOM_VALUES","LIFE_KINDS","LIFE_PHASES","MEAL_TYPES","MEAL_AMOUNTS","LIFE_EXTRAS","SLEEP_QUALITY","EXERCISE_TYPES","EXERCISE_INTENSITY","BOWEL_CONSISTENCY","BODY_SYMPTOMS"];
for(const n of NAMES){
  const a=fromTs(n), b=fromJs(n);
  ok(Array.isArray(a) && a.length>0, `${n}: schema.ts에서 읽음`);
  ok(JSON.stringify(a)===JSON.stringify(b), `${n}: schema.ts == cloud-bridge.js`);
  ok(sql.includes(sqlArray(a)), `${n}: SQL 검증 함수에 같은 목록`);
}
// 앱 원본 상수와 비교
const appState=[...app.matchAll(/\{key:"([a-z]+)",\s+ko:/g)].map(m=>m[1]);
ok(JSON.stringify(fromTs("STATE_VALUES"))===JSON.stringify(appState.slice(0,10)), "STATE_VALUES == 앱 STATES 키 순서");
const appSym=(()=>{ const blk=/const SYMPTOMS = \[([\s\S]*?)\];/.exec(app)[1]; return [...blk.matchAll(/key:"([a-z_]+)"/g)].map(m=>m[1]); })();
ok(JSON.stringify(fromTs("SYMPTOM_VALUES"))===JSON.stringify(appSym), "SYMPTOM_VALUES == 앱 SYMPTOMS");
for(const [bridge, appName, drop] of [["MEAL_TYPES","MEAL_TYPES"],["MEAL_AMOUNTS","MEAL_AMOUNTS"],["SLEEP_QUALITY","SLEEP_QUALITY"],["EXERCISE_INTENSITY","EXERCISE_INTENSITY"],["BOWEL_CONSISTENCY","BOWEL_CONSISTENCY"],["BODY_SYMPTOMS","BODY_SYMPTOMS"],["EXERCISE_TYPES","EXERCISE_TYPES","기타"]]){
  const appVals=fromApp(appName).filter(v=>v!==drop);
  ok(JSON.stringify(appVals)===JSON.stringify(fromTs(bridge)), `${bridge} == 앱 ${appName}${drop?` (사용자 정의 '${drop}' 제외)`:""}`);
}
ok(JSON.stringify([...fromApp("MEAL_EXTRAS"), ...fromApp("BOWEL_EXTRAS")])===JSON.stringify(fromTs("LIFE_EXTRAS")), "LIFE_EXTRAS == 앱 MEAL_EXTRAS + BOWEL_EXTRAS");
const appLife=[...(/const LIFE = \{([\s\S]*?)\};/.exec(app)[1]).matchAll(/^\s+([a-z]+):/gm)].map(m=>m[1]);
ok(JSON.stringify(appLife)===JSON.stringify(fromTs("LIFE_KINDS")), "LIFE_KINDS == 앱 LIFE 키");

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
