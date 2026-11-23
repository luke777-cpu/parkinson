/* 클라우드 연동(시험) — 네트워크 없이 검증하는 부분
 *  A. 기본 비활성: 설정이 비어 있으면 끌 수도 켤 수도 없고 네트워크 호출 0건
 *  B. 원문 백업 → 분리된 브라우저(프로필)에서 복구: 바이트 단위 일치, 손상 백업은 쓰기 전 차단
 *  C. 이벤트 변환: 허용 값만, 단위·값 추정 금지, 자유 텍스트 제외
 *  D. 로컬 분류: ID 중복=충돌, ID 없음=확인 후 별도 목록에 안정 ID, 원본 키 불변
 *  E. 서비스 워커: 다른 출처·인증·원격 기록 응답은 캐시하지 않음
 * 가상 데이터만 사용한다. */
const fs=require('fs'), path=require('path'), vm=require('vm');
const {JSDOM}=require('jsdom');
const {webcrypto}=require('crypto');
const ROOT=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(ROOT,'index.html'),'utf-8');
const bridgeSrc=fs.readFileSync(path.join(ROOT,'cloud-bridge.js'),'utf-8');
const configSrc=fs.readFileSync(path.join(ROOT,'cloud-config.js'),'utf-8');

let pass=0, fail=0;
const ok=(c,n)=>{ c?pass++:fail++; console.log((c?"  ✔ ":"  ✘ FAIL: ")+n); };

function newWindow(url){
  const dom=new JSDOM(html,{runScripts:"dangerously",url:url||"https://localhost/",pretendToBeVisual:true});
  const w=dom.window;
  w._errs=[]; w.addEventListener("error",e=>w._errs.push(e.message));
  Object.defineProperty(w,"crypto",{value:webcrypto, configurable:true});
  w.TextEncoder=TextEncoder; w.TextDecoder=TextDecoder;
  w._fetchCalls=0; w.fetch=()=>{ w._fetchCalls++; return Promise.reject(new TypeError("offline")); };
  w.eval(configSrc); w.eval(bridgeSrc);
  return w;
}
function seed(w, events){
  const KEY=w.eval("KEY");
  w.localStorage.setItem(KEY, JSON.stringify({ events, meds:[{name:"가상약", dose:100, sched:["07:00"]}], questions:[], settings:{theme:"light",notify:true,lang:"ko"}, outputChecks:[], dayMemos:{} }));
  w.eval("db=load(); renderAll();");
}
const now=Date.now();
const VIRTUAL=[
  {id:"v1",type:"med",drug:"가상약 HBS",dose:125,ts:now-3600e3,memo:"비공개 메모 😀"},
  {id:"v2",type:"state",state:"off",ts:now-3000e3,output:15,trend:"stable",symptoms:["tremor"],customSymptom:"사용자 정의"},
  {id:"v3",type:"state",state:"on",ts:now-1800e3,output:80,trend:"rising",symptoms:[]},
  {id:"v4",type:"life",kind:"meal",mealType:"점심",amount:"보통",extras:["단백질 많음"],ts:now-1200e3,protein:false,quality:[],symptoms:[]},
  {id:"v5",type:"life",kind:"exercise",phase:"start",exType:"기타",exTypeCustom:"수영",intensity:"보통",durationMin:30,ts:now-900e3,quality:[],extras:[],symptoms:[]},
  {id:"v6",type:"med",drug:"가상약",dose:"50mg",ts:now-600e3},
  {id:"v6",type:"state",state:"on",ts:now-500e3},
  {type:"state",state:"falling",ts:now-400e3,output:40},
  {id:"v8",type:"tempnote",ts:now-300e3,dir:"up"},
];

(async()=>{
  console.log("== A. 기본 비활성 ==");
  {
    const w=newWindow(); seed(w, VIRTUAL); w.CloudBridge.render();
    const card=w.document.getElementById("cloudBridgeCard");
    ok(!!card, "설정 화면에 클라우드 카드 자리 존재");
    ok(w.CloudBridge.configured()===false, "공개 설정이 비어 있으면 미설정");
    ok(card.textContent.includes("설정이 없어 꺼져"), "미설정 안내 표시");
    ok(!w.document.getElementById("cbToggle"), "미설정이면 켜기 버튼 없음");
    ok(w.CloudBridge.isEnabled()===false, "기본값 비활성");
    ok(w._fetchCalls===0, "로드만으로 네트워크 호출 0건");
    ok(w._errs.length===0, "콘솔/윈도우 오류 0건 "+JSON.stringify(w._errs));
    const cfg=configSrc.replace(/\/\*[\s\S]*?\*\//g,"");
    ok(!/service_role|sb_secret|eyJ/.test(cfg), "공개 설정 파일에 secret/service_role/JWT 없음");
  }

  console.log("== B. 원문 백업·복구(분리된 프로필) ==");
  {
    const a=newWindow("https://localhost/"); seed(a, VIRTUAL);
    const KEY=a.eval("KEY");
    // 원문을 일부러 사람이 만든 들여쓰기·키 순서로 저장해 "재직렬화가 아닌 원문"인지 확인
    const handRaw='{\n  "settings": {"lang":"ko","theme":"light","notify":true},\n  "events": '+JSON.stringify(VIRTUAL)+',\n  "meds": [], "외부키": "유지 😀"\n}';
    a.localStorage.setItem(KEY, handRaw);
    const b=await a.CloudBridge.makeRawBackup();
    ok(b.raw===handRaw, "백업 raw는 저장소 원문 그대로(재직렬화 아님)");
    ok(b.byte_length===Buffer.byteLength(handRaw,"utf8"), "바이트 수 기록: "+b.byte_length);
    ok(b.sha256===require('crypto').createHash('sha256').update(handRaw,'utf8').digest('hex'), "SHA-256 일치");
    ok(b.format==="yakhyo-raw-backup" && b.format_version===1 && !!b.created_at, "형식·버전·생성 시각 포함");
    const fileText=JSON.stringify(b);

    const p2=newWindow("https://localhost/"); // 별도 프로필(빈 저장소)
    p2.localStorage.clear();
    const r=await p2.CloudBridge.restoreRawBackup(fileText);
    ok(r.ok===true, "분리된 프로필에서 복구 성공");
    const restored=p2.localStorage.getItem(KEY);
    ok(Buffer.from(restored,'utf8').equals(Buffer.from(handRaw,'utf8')), "복구 결과가 바이트 단위로 일치");

    const p3=newWindow("https://localhost/"); seed(p3, [{id:"keep",type:"state",state:"on",ts:now}]);
    const before=p3.localStorage.getItem(KEY);
    const tampered=[
      ["SHA256", JSON.stringify({...b, raw:b.raw.replace("유지","변조")})],
      ["BYTE_LENGTH", JSON.stringify({...b, byte_length:b.byte_length+1})],
      ["FORMAT", JSON.stringify({...b, format:"other"})],
      ["STORAGE_KEY", JSON.stringify({...b, storage_key:"x"})],
      ["JSON_PARSE", fileText.slice(0, fileText.length-5)],
    ];
    for(const [reason, t] of tampered){
      const v=await p3.CloudBridge.restoreRawBackup(t);
      ok(v.ok===false && v.reason===reason, `손상 백업 차단: ${reason}`);
    }
    ok(p3.localStorage.getItem(KEY)===before, "차단된 경우 기존 원본 불변");
    const badShapeRaw='{"events":"x"}';
    const shaBad=require('crypto').createHash('sha256').update(badShapeRaw).digest('hex');
    const v2=await p3.CloudBridge.restoreRawBackup(JSON.stringify({...b, raw:badShapeRaw, byte_length:badShapeRaw.length, sha256:shaBad}));
    ok(v2.ok===false && v2.reason==="RAW_SHAPE", "해시가 맞아도 앱 형식이 아니면 차단");
  }

  console.log("== C. 이벤트 변환 ==");
  {
    const w=newWindow(); const C=w.CloudBridge.convertEvent;
    const m=C(VIRTUAL[0]);
    ok(m.ok && JSON.stringify(m.payload)===JSON.stringify({drug:"가상약 HBS",dose_mg:125}) && m.excludedText===true, "복약: 약명·mg만, 메모는 제외 표시");
    ok(C(VIRTUAL[5]).ok===false && C(VIRTUAL[5]).reason==="dose_unit", "'50mg' 같은 단위 섞인 용량은 추정하지 않고 변환 불가");
    ok(C({type:"med",drug:"가상약",dose:null,ts:now}).ok && C({type:"med",drug:"가상약",dose:null,ts:now}).payload.dose_mg===undefined, "용량 없음은 비워 둠");
    ok(C({type:"med",drug:"가상약",dose:"100",ts:now}).payload.dose_mg===100, "숫자 문자열은 mg 숫자로");
    const s=C(VIRTUAL[1]);
    ok(s.ok && s.payload.state==="off" && s.payload.output===15 && s.payload.symptoms[0]==="tremor" && !("customSymptom" in s.payload) && s.excludedText, "상태: 허용 필드만, 사용자 정의 증상 제외");
    ok(C({type:"state",state:"unknown",ts:now}).ok===false, "알 수 없는 상태는 변환 불가");
    ok(C({type:"state",state:"on",output:150,ts:now}).ok===false, "범위 밖 출력은 변환 불가");
    ok(C({type:"state",state:"on",symptoms:["새증상"],ts:now}).ok===false, "목록 밖 증상은 변환 불가");
    const l=C(VIRTUAL[3]);
    ok(l.ok && l.payload.meal_type==="점심" && l.payload.amount==="보통" && l.payload.extras[0]==="단백질 많음" && !("protein" in l.payload), "식사: 허용 필드 매핑");
    const ex=C(VIRTUAL[4]);
    ok(ex.ok && !("ex_type" in ex.payload) && ex.payload.duration_min===30 && ex.excludedText, "운동 '기타'(사용자 정의)는 종류를 보내지 않음");
    ok(C({type:"state",state:"on",ts:"2026-01-01"}).ok===false, "시각이 숫자가 아니면 변환 불가");
    ok(C({type:"state",state:"on",ts:now+3*86400e3}).ok===false, "먼 미래 시각은 변환 불가");
    ok(C(VIRTUAL[8]).ok===false, "임시기록 등 범위 밖 유형은 제외");
  }

  console.log("== D. 로컬 분류·ID 부여 ==");
  {
    const w=newWindow(); seed(w, VIRTUAL);
    const KEY=w.eval("KEY"); const raw0=w.localStorage.getItem(KEY);
    const r=await w.CloudBridge.classifyLocal(VIRTUAL, now-86400e3, now+60e3);
    ok(r.candidates.map(c=>c.legacy_id).join(",")==="v1,v2,v3,v4,v5", "추가 후보: v1~v5 "+r.candidates.map(c=>c.legacy_id));
    ok(r.localConflict.length===1, "같은 ID(v6) 두 번 중 변환 가능한 하나는 충돌로(자동 병합 안 함)");
    ok(r.invalid.length===1 && r.invalid[0].reason==="dose_unit", "변환 불가 1건(단위)");
    ok(r.needsId.length===1, "ID 없는 항목은 확인 대상");
    ok(r.excludedText===3, "자유 텍스트 제외 건수 3");
    w.CloudBridge.assignIds(r.needsId);
    const r2=await w.CloudBridge.classifyLocal(VIRTUAL, now-86400e3, now+60e3);
    const noid=r2.candidates.find(c=>c.legacy_id.startsWith("noid-"));
    ok(!!noid && r2.needsId.length===0, "확인 후 별도 목록의 안정 ID로 후보 편입: "+(noid&&noid.legacy_id));
    const r3=await w.CloudBridge.classifyLocal(VIRTUAL, now-86400e3, now+60e3);
    ok(r3.candidates.find(c=>c.legacy_id.startsWith("noid-")).legacy_id===noid.legacy_id, "재계산해도 같은 ID(안정)");
    ok(w.localStorage.getItem(KEY)===raw0, "분류·ID 부여가 yakhyo_log_v1을 바꾸지 않음");
    const it=w.CloudBridge.toItem(r2.candidates[0]);
    ok(/Z$/.test(it.occurred_at) && Date.parse(it.occurred_at)===VIRTUAL[0].ts, "원래 epoch ms 시점 보존(UTC ISO)");
  }

  console.log("== E. 켜기·오프라인에서도 로컬 기능 유지 ==");
  {
    const w=newWindow(); seed(w, VIRTUAL);
    w.YAKHYO_CLOUD_CONFIG={supabaseUrl:"https://staging.example.test", publishableKey:"sb_publishable_test"};
    w.localStorage.setItem("yakhyo_cloud_enabled_v1","1");
    w.CloudBridge.render();
    ok(!!w.document.getElementById("cbLogin"), "켜면 로그인 입력 표시(자동 전송 없음)");
    ok(w._fetchCalls===0, "켜기만으로는 네트워크 호출 0건");
    w.document.getElementById("cbEmail").value="a@example.test"; w.document.getElementById("cbPw").value="x".repeat(12);
    w.document.getElementById("cbLogin").click();
    await new Promise(r=>setTimeout(r,50));
    ok(w.document.getElementById("cbMsg").textContent.includes("연결할 수 없어요"), "오프라인 로그인 실패 안내: "+w.document.getElementById("cbMsg").textContent);
    ok(w.document.getElementById("cbPw").value==="", "비밀번호 입력칸 즉시 비움");
    const n0=w.eval("db.events.length");
    w.eval('addState("on",{output:70})');
    const KEY=w.eval("KEY");
    ok(JSON.parse(w.localStorage.getItem(KEY)).events.length===n0+1, "오프라인에서도 로컬 기록 추가·저장 정상");
    ok(JSON.parse(w.localStorage.getItem(KEY)).settings.notify===true, "설정(알림) 그대로");
    ok(!Object.keys(w.localStorage).some(k=>/token|session/i.test(k)), "localStorage에 세션·토큰 키 없음");
  }

  console.log("== F. 서비스 워커 캐시 제외 ==");
  {
    const sw=fs.readFileSync(path.join(ROOT,'sw.js'),'utf-8');
    const handlers={}; let responded=0;
    const ctx={ self:{ addEventListener(t,f){ handlers[t]=f; }, location:{origin:"https://luke777-cpu.github.io"}, skipWaiting(){}, clients:{claim(){}} },
      caches:{ open:async()=>({ put(){}, addAll:async()=>{}, add:async()=>{} }), match:async()=>undefined, keys:async()=>[] },
      fetch:async()=>({ok:true,type:"basic",clone(){return this;}}), URL, Promise, console };
    vm.createContext(ctx); new vm.Script(sw).runInContext(ctx);
    const fire=(url, mode)=>{ responded=0; handlers.fetch({request:{method:"GET", url, mode}, respondWith(){ responded++; }}); return responded; };
    ok(fire("https://abc.supabase.co/rest/v1/diary_events?select=*")===0, "Supabase Data API 요청은 가로채지 않음");
    ok(fire("https://abc.supabase.co/auth/v1/token?grant_type=password")===0, "Supabase Auth 요청은 가로채지 않음");
    ok(fire("https://luke777-cpu.github.io/parkinson/rest/v1/x")===0, "같은 출처라도 /rest/v1/ 경로는 제외");
    ok(fire("https://luke777-cpu.github.io/parkinson/index.html","navigate")===1, "앱 셸 탐색은 기존대로 처리");
    ok(/response\.type === "basic"\)/.test(sw) && !/"cors"/.test(sw), "교차 출처(cors) 응답은 캐시에 저장하지 않음");
    ok(sw.includes('"./cloud-bridge.js"') && sw.includes('"./cloud-config.js"'), "새 스크립트를 앱 셸에 포함(오프라인 로딩)");
  }


  console.log("== G. 서버 기록 가져오기 ==");
  {
    const w=newWindow(); seed(w, VIRTUAL);
    const CB=w.CloudBridge, KEY=w.eval("KEY");
    const rows=[
      {id:"11111111-1111-4111-8111-111111111111", kind:"med", occurred_at:"2026-11-22T07:00:00+09:00", payload:{drug:"가상약",dose_mg:100}, source:"agent_request", legacy_id:null},
      {id:"22222222-2222-4222-8222-222222222222", kind:"state", occurred_at:"2026-11-22T08:00:00+09:00", payload:{state:"on",output:80,symptoms:["tremor"]}, source:"agent_request", legacy_id:null},
      {id:"33333333-3333-4333-8333-333333333333", kind:"life", occurred_at:"2026-11-22T12:00:00+09:00", payload:{kind:"meal",meal_type:"점심",extras:["단백질 많음"]}, source:"agent_request", legacy_id:null},
      {id:"44444444-4444-4444-8444-444444444444", kind:"state", occurred_at:new Date(VIRTUAL[2].ts).toISOString(), payload:{state:"on",output:80}, source:"browser_upload", legacy_id:"v3"},
      {id:"55555555-5555-4555-8555-555555555555", kind:"state", occurred_at:new Date(VIRTUAL[1].ts).toISOString(), payload:{state:"off",output:15}, source:"agent_request", legacy_id:null},
      {id:"66666666-6666-4666-8666-666666666666", kind:"state", occurred_at:"2026-11-22T09:00:00+09:00", payload:{state:"???"}, source:"agent_request", legacy_id:null},
    ];
    const m=CB.remoteToLocal(rows[0]);
    ok(m.type==="med" && m.drug==="가상약" && m.dose===100 && m.ts===Date.parse(rows[0].occurred_at) && m.id==="cloud-"+rows[0].id && m.cloudId===rows[0].id, "복약 변환(앱 addMed 모양, cloudId 표시)");
    const st=CB.remoteToLocal(rows[1]);
    ok(st.type==="state" && st.output===80 && st.trend===null && st.symptoms[0]==="tremor" && st.inputMethod==="cloud_import", "상태 변환(없는 값은 null, 추정 안 함)");
    const lf=CB.remoteToLocal(rows[2]);
    ok(lf.type==="life" && lf.kind==="meal" && lf.mealType==="점심" && lf.extras[0]==="단백질 많음", "생활 변환");
    const c=CB.classifyRemote(rows, w.eval("db.events"));
    ok(c.add.length===3 && c.already.length===1 && c.dupe.length===1 && c.invalid.length===1, `분류: 새로 3·이미 1(이 기기에서 올린 것)·중복 후보 1·변환 불가 1 → ${c.add.length}/${c.already.length}/${c.dupe.length}/${c.invalid.length}`);
    const n0=w.eval("db.events.length"), raw0=w.localStorage.getItem(KEY);
    const r=await CB.importLocalEvents(c.add.map(x=>x.ev));
    ok(r.ok && r.added===3, "3건 가져오기");
    const saved=JSON.parse(w.localStorage.getItem(KEY));
    ok(saved.events.length===n0+3 && w.eval("db.events.length")===n0+3, "앱 메모리 db와 저장소 모두 반영(save 경로)");
    ok(saved.events.filter(e=>!e.cloudId).length===n0, "기존 기록은 그대로(추가만)");
    ok(saved.meds.length===1 && saved.settings.notify===true, "약 목록·설정 불변");
    const bk=JSON.parse(w.localStorage.getItem(CB.IMPORT_BACKUP_KEY));
    ok(bk.raw===raw0 && bk.sha256===require('crypto').createHash('sha256').update(raw0,'utf8').digest('hex'), "가져오기 직전 원문 자동 백업(SHA-256)");
    const r2=await CB.importLocalEvents(c.add.map(x=>x.ev));
    ok(r2.ok && r2.added===0 && JSON.parse(w.localStorage.getItem(KEY)).events.length===n0+3, "같은 서버 기록 두 번 가져와도 중복 없음");
    const c2=CB.classifyRemote(rows, w.eval("db.events"));
    ok(c2.add.length===0 && c2.already.length===4, "다시 미리보기하면 이미 있음 4");
    const lc=await CB.classifyLocal(w.eval("db.events"), 0, Date.now()+86400e3);
    ok(!lc.candidates.some(x=>String(x.legacy_id).startsWith("cloud-")), "가져온 기록은 다시 올리기 후보에서 제외");
    w.eval("renderAll()"); w.eval("switchTab('log')");
    ok(w._errs.length===0 && w.document.body.textContent.includes("가상약"), "가져온 기록이 앱 화면에 표시, 오류 0건 "+JSON.stringify(w._errs));
    const u=await CB.undoImport();
    ok(u.ok && w.localStorage.getItem(KEY)===raw0 && !w.localStorage.getItem(CB.IMPORT_BACKUP_KEY), "되돌리기: 직전 원문 그대로 복원, 백업 키 정리");
    w.localStorage.setItem(CB.IMPORT_BACKUP_KEY, JSON.stringify({...bk, raw:bk.raw+"x"}));
    const u2=await CB.undoImport();
    ok(!u2.ok && u2.reason==="BACKUP_CORRUPT" && w.localStorage.getItem(KEY)===raw0, "손상된 백업이면 되돌리지 않음");
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error("TEST HARNESS ERROR:", e); process.exit(1); });
