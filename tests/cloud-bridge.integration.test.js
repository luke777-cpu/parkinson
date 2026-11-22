/* 클라우드 연동(시험) 브라우저 흐름 — 실제 로컬 Supabase(Auth+PostgREST+Postgres)와 통신
 * 실행 전: tools/local-stack/start.sh (스택이 없으면 SKIP)
 * 미리보기 → 업로드(중간 실패 → 같은 요청 키로 재개) → 이미 등록 판정 → 에이전트 요청 승인 → 원격 읽기 → 연결 폐기
 * 모든 단계에서 yakhyo_log_v1 원문이 바이트 단위로 그대로인지 확인한다. 가상 데이터만 사용. */
const fs=require('fs'), path=require('path');
const {JSDOM}=require('jsdom');
const {webcrypto, randomUUID}=require('crypto');
const ROOT=path.join(__dirname,'..');
const DIR=process.env.LOCAL_STACK_DIR||"/tmp/yakhyo-mcp-local";
if(!fs.existsSync(`${DIR}/stack.json`)){ console.log("SKIP: 로컬 스택 없음 (tools/local-stack/start.sh)"); process.exit(0); }
const stack=JSON.parse(fs.readFileSync(`${DIR}/stack.json`,'utf8'));
const html=fs.readFileSync(path.join(ROOT,'index.html'),'utf-8');
const bridgeSrc=fs.readFileSync(path.join(ROOT,'cloud-bridge.js'),'utf-8');

let pass=0, fail=0;
const ok=(c,n)=>{ c?pass++:fail++; console.log((c?"  ✔ ":"  ✘ FAIL: ")+n); };
const tick=(ms=80)=>new Promise(r=>setTimeout(r,ms));
async function until(fn, ms=5000){ const t0=Date.now(); while(Date.now()-t0<ms){ if(await fn()) return true; await tick(50); } return false; }

(async()=>{
  const seedMod=await import(path.join(ROOT,'tools/local-stack/seed.mjs'));
  const client=await import(path.join(ROOT,'tools/local-stack/client.mjs'));
  const tag=randomUUID().slice(0,8), pw=randomUUID();
  const uid=await seedMod.adminCreateUser(`cb-u-${tag}@example.test`, pw);
  const aid=await seedMod.adminCreateUser(`cb-a-${tag}@example.test`, pw);
  seedMod.sql(`insert into public.diary_agent_links(agent_id, owner_id, expires_at) values ('${aid}','${uid}', now() + interval '1 day')`);
  const agentTok=await client.login({email:`cb-a-${tag}@example.test`, password:pw});

  const dom=new JSDOM(html,{runScripts:"dangerously",url:"http://127.0.0.1:8080/",pretendToBeVisual:true});
  const w=dom.window;
  Object.defineProperty(w,"crypto",{value:webcrypto, configurable:true});
  w.TextEncoder=TextEncoder; w.TextDecoder=TextDecoder;
  w.confirm=()=>true;
  let failNextImportKey=null, offline=false;
  w.fetch=(url, init)=>{
    if(offline) return Promise.reject(new TypeError("Failed to fetch"));
    if(failNextImportKey && init && init.body && String(init.body).includes(failNextImportKey)){ failNextImportKey=null; return Promise.reject(new TypeError("network dropped")); }
    return fetch(url, init);
  };
  const KEY="yakhyo_log_v1";
  const base=Date.parse("2026-11-12T00:00:00+09:00");
  const events=[];
  for(let i=0;i<150;i++) events.push({id:`cb${i}`, type:"state", state:i%2?"on":"off", ts:base+i*5*60e3, output:i%2?80:20, trend:"stable", symptoms:[], customSymptom:""});
  events.push({id:"cbmed", type:"med", drug:"가상약", dose:100, ts:base-30*60e3, memo:"메모는 안 보냄"});
  const raw=JSON.stringify({events, meds:[{name:"가상약",dose:100,sched:["07:00"]}], questions:[], settings:{theme:"light",notify:true,lang:"ko"}, outputChecks:[], dayMemos:{}});
  w.localStorage.setItem(KEY, raw);
  w.eval("db=load(); renderAll();");
  w.YAKHYO_CLOUD_CONFIG={supabaseUrl:stack.url, publishableKey:stack.publishableKey};
  w.eval(bridgeSrc);
  const CB=w.CloudBridge;
  const rawUnchanged=()=>w.localStorage.getItem(KEY)===raw;

  console.log("== 로그인 ==");
  w.localStorage.setItem(CB.ENABLED_KEY,"1"); CB.render();
  w.document.getElementById("cbEmail").value=`cb-u-${tag}@example.test`;
  w.document.getElementById("cbPw").value=pw;
  w.document.getElementById("cbLogin").click();
  ok(await until(()=>!!w.document.getElementById("cbPreview")), "로그인 후 기능 표시");
  ok(!!w.sessionStorage.getItem(CB.SESSION_KEY), "세션은 sessionStorage(이 탭)에만");
  ok(!Object.keys(w.localStorage).some(k=>/session|token/i.test(k)) && !w.localStorage.getItem(KEY).includes("access_token"), "localStorage·원본에 토큰 없음");

  console.log("== 미리보기 ==");
  w.document.getElementById("cbFrom").value="2026-11-11"; w.document.getElementById("cbTo").value="2026-11-12";
  w.document.getElementById("cbPreview").click();
  ok(await until(()=>!!w.document.getElementById("cbCntAdd")), "미리보기 표시");
  ok(w.document.getElementById("cbCntAdd").textContent==="151", "추가 가능 151건: "+w.document.getElementById("cbCntAdd").textContent);
  ok(w.document.getElementById("cbCntAlready").textContent==="0" && w.document.getElementById("cbCntConflict").textContent==="0", "이미 등록·충돌 0");
  ok(rawUnchanged(), "미리보기 후 원본 불변");

  console.log("== 업로드: 두 번째 배치에서 네트워크 끊김 → 재개 ==");
  const picks=CB._ui.preview.add.map(x=>x.item);
  const plan=CB.makePlan(uid, picks);
  ok(plan.batches.length===2 && plan.batches[0].items.length===100, "100건 단위 2개 배치, 요청 키 사전 저장");
  const keys=plan.batches.map(b=>b.request_key);
  failNextImportKey=keys[1];
  let threw=false; try{ await CB.runPlan(uid); }catch(e){ threw=true; }
  const st1=CB.readUpload(uid);
  ok(threw && st1.batches[0].status==="done" && st1.batches[1].status==="error", "1번 배치 완료, 2번 배치 오류 상태로 기록");
  ok(CB.summarizePlan(st1).inserted===100 && CB.summarizePlan(st1).pending===51, "중간 결과: 100건 추가, 51건 남음");
  ok(rawUnchanged(), "업로드 오류 후에도 원본 불변");
  const st2=await CB.runPlan(uid);
  ok(st2.batches.map(b=>b.request_key).join()===keys.join(), "재개 시 같은 요청 키 사용");
  ok(CB.summarizePlan(st2).inserted===151 && CB.summarizePlan(st2).pending===0, "재개 후 151건 모두 추가");
  const cnt=seedMod.sql(`select count(*) from public.diary_events where user_id='${uid}'`);
  ok(cnt==="151", "DB 확정 행 151건(중복 없음): "+cnt);
  const memoLeak=seedMod.sql(`select count(*) from public.diary_events where user_id='${uid}' and payload::text like '%메모%'`);
  ok(memoLeak==="0", "메모는 원격에 없음");
  // 같은 항목을 새 계획으로 다시 보내도 이미 등록
  CB.makePlan(uid, picks.slice(0,5));
  const st3=await CB.runPlan(uid);
  ok(CB.summarizePlan(st3).already===5 && CB.summarizePlan(st3).inserted===0, "같은 기존 ID 재전송은 이미 등록(5)");
  ok(seedMod.sql(`select count(*) from public.diary_events where user_id='${uid}'`)==="151", "행 수 변화 없음");

  console.log("== 미리보기 재계산: 이미 등록/충돌 ==");
  const changedRaw=JSON.parse(raw); changedRaw.events[0].output=55; // 로컬에서 수정된 기록 → 원격과 내용이 다름
  w.localStorage.setItem(KEY, JSON.stringify(changedRaw));
  w.document.getElementById("cbPreview").click();
  ok(await until(()=>w.document.getElementById("cbCntAlready") && w.document.getElementById("cbCntAlready").textContent==="150"), "이미 등록 150");
  ok(w.document.getElementById("cbCntConflict").textContent==="1", "로컬 수정분은 충돌 1(자동 전파·병합 안 함)");
  ok(seedMod.sql(`select payload->>'output' from public.diary_events where user_id='${uid}' and legacy_id='cb0'`)==="20", "원격 기록은 로컬 수정으로 바뀌지 않음");
  w.localStorage.setItem(KEY, raw);

  console.log("== 에이전트 요청 승인 ==");
  const p=await client.rpc(agentTok, "create_pending_event", {p_request_id:`cb-${tag}-r1`, p_kind:"state", p_occurred_at:"2026-11-12T13:00:00+09:00", p_source_tz:"Asia/Seoul", p_payload:{state:"on",output:75}});
  ok(p.status===200, "에이전트 요청 생성");
  const dup=await client.rpc(agentTok, "create_pending_event", {p_request_id:`cb-${tag}-r2`, p_kind:"state", p_occurred_at:new Date(base).toISOString(), p_source_tz:"Asia/Seoul", p_payload:{state:"off",output:20,trend:"stable"}});
  ok(dup.status===200, "기존 확정 기록과 같은 내용의 요청 생성");
  w.document.getElementById("cbPending").click();
  ok(await until(()=>w.document.querySelectorAll(".cbApprove").length===2), "승인 대기 2건 표시");
  ok(w.document.getElementById("cbPendingBox").textContent.includes("중복 후보"), "중복 후보 표시");
  const approveBtn=[...w.document.querySelectorAll("#cbPendingBox .li")].find(li=>li.textContent.includes("출력 75")).querySelector(".cbApprove");
  approveBtn.click();
  ok(await until(()=>w.document.querySelectorAll(".cbApprove").length===1), "승인 후 목록 1건");
  w.document.querySelector(".cbReject").click();
  ok(await until(()=>w.document.getElementById("cbPendingBox").textContent.includes("대기 중인 요청이 없어요")), "거절 후 목록 비움");
  ok(seedMod.sql(`select count(*) from public.diary_events where user_id='${uid}' and source='agent_request'`)==="1", "승인 1건만 확정");

  console.log("== 원격 읽기 영역 ==");
  w.document.getElementById("cbDay").value="2026-11-12";
  w.document.getElementById("cbRemote").click();
  ok(await until(()=>w.document.getElementById("cbRemoteBox").textContent.includes("에이전트 요청 승인")), "원격 기록을 별도 영역에 표시(에이전트 승인분 포함)");
  ok(w.eval("db.events.length")===151, "원격 기록이 로컬 db로 들어오지 않음");
  ok(rawUnchanged(), "승인·조회 후 원본 불변");

  console.log("== 오프라인 ==");
  offline=true;
  w.document.getElementById("cbRemote").click(); await tick(150);
  ok(w.document.getElementById("cbMsg").textContent.includes("연결할 수 없어요"), "오프라인 안내");
  w.eval('addState("on",{output:60})');
  ok(JSON.parse(w.localStorage.getItem(KEY)).events.length===152, "오프라인에서도 로컬 기록 동작");
  w.localStorage.setItem(KEY, raw); w.eval("db=load()");
  offline=false;

  console.log("== 연결 폐기 ==");
  w.document.getElementById("cbLinks").click();
  ok(await until(()=>!!w.document.querySelector(".cbRevoke")), "에이전트 연결 표시");
  w.document.querySelector(".cbRevoke").click();
  ok(await until(()=>w.document.getElementById("cbLinksBox").textContent.includes("폐기됨")), "폐기 후 상태 표시");
  const after=await client.rpc(agentTok, "my_agent_link", {});
  ok(Array.isArray(after.json) && after.json.length===0, "같은 에이전트 토큰의 연결 즉시 무효");
  const agentRead=await client.rest(agentTok, "GET", "/diary_events?select=id");
  ok(Array.isArray(agentRead.json) && agentRead.json.length===0, "폐기 후 에이전트 조회 0건");

  console.log("== 서버 기록 가져오기(앱 기록에 추가) ==");
  w.document.getElementById("cbImpFrom").value="2026-11-11"; w.document.getElementById("cbImpTo").value="2026-11-12";
  w.document.getElementById("cbImpPreview").click();
  ok(await until(()=>!!w.document.getElementById("cbImpCntAdd")), "가져오기 미리보기 표시");
  ok(w.document.getElementById("cbImpCntAdd").textContent==="1", "가져올 수 있음 1(에이전트 승인분): "+w.document.getElementById("cbImpCntAdd").textContent);
  ok(w.document.getElementById("cbImpCntAlready").textContent==="151", "이 기기에서 올린 151건은 이미 있음: "+w.document.getElementById("cbImpCntAlready").textContent);
  const nBefore=w.eval("db.events.length");
  w.document.getElementById("cbImpRun").click();
  ok(await until(()=>w.eval("db.events.length")===nBefore+1), "1건 추가");
  const imported=JSON.parse(w.localStorage.getItem(KEY)).events.filter(e=>e.cloudId);
  ok(imported.length===1 && imported[0].type==="state" && imported[0].output===75 && imported[0].cloudSource==="agent_request", "가져온 기록 = 승인된 상태 기록(출력 75)");
  ok(JSON.parse(w.localStorage.getItem(KEY)).events.filter(e=>!e.cloudId).length===151, "기존 151건 그대로(추가만)");
  w.document.getElementById("cbImpFrom").value="2026-11-11"; w.document.getElementById("cbImpTo").value="2026-11-12";
  w.document.getElementById("cbImpPreview").click();
  ok(await until(()=>w.document.getElementById("cbImpCntAlready") && w.document.getElementById("cbImpCntAlready").textContent==="152"), "다시 미리보기: 이미 있음 152, 가져올 것 0");
  CB.makePlan(uid, []); // 빈 계획
  const lc=await CB.classifyLocal(JSON.parse(w.localStorage.getItem(KEY)).events, 0, Date.now()+86400e3);
  ok(!lc.candidates.some(c=>c.event.cloudId), "가져온 기록은 다시 올리기 대상 아님");
  const undo=await CB.undoImport(); w.eval("db=load()");
  ok(undo.ok && rawUnchanged(), "되돌리기로 가져오기 전 원문 복원");

  console.log("== 에이전트 계정으로 앱 로그인 ==");
  const dom2=new JSDOM(html,{runScripts:"dangerously",url:"http://127.0.0.1:8080/",pretendToBeVisual:true});
  const w2=dom2.window; Object.defineProperty(w2,"crypto",{value:webcrypto,configurable:true}); w2.TextEncoder=TextEncoder; w2.fetch=(u,i)=>fetch(u,i); w2.confirm=()=>true;
  w2.YAKHYO_CLOUD_CONFIG={supabaseUrl:stack.url, publishableKey:stack.publishableKey}; w2.eval(bridgeSrc);
  w2.localStorage.setItem(w2.CloudBridge.ENABLED_KEY,"1"); w2.CloudBridge.render();
  w2.document.getElementById("cbEmail").value=`cb-a-${tag}@example.test`; w2.document.getElementById("cbPw").value=pw;
  w2.document.getElementById("cbLogin").click();
  ok(await until(()=>!!w2.document.getElementById("cbAgentNotice")), "에이전트 전용 계정 안내 표시(연결 폐기 후에도)");
  ok(!w2.document.getElementById("cbPending") && !w2.document.getElementById("cbPreview") && !w2.document.getElementById("cbImpPreview"), "승인·올리기·가져오기 버튼 숨김");

  console.log("== 로그아웃 ==");
  w.document.getElementById("cbLogout").click(); await tick(150);
  ok(!w.sessionStorage.getItem(CB.SESSION_KEY), "로그아웃 시 세션 삭제");
  ok(rawUnchanged(), "전 과정에서 yakhyo_log_v1 원문 불변");

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error("TEST HARNESS ERROR:", e); process.exit(1); });
