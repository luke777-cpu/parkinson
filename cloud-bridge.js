/* 약효일지 클라우드 연동(시험, B단계) — 기본 비활성.
 *
 * 원칙
 *  - 로컬 원본(localStorage "yakhyo_log_v1")에 쓰는 경로는 둘뿐이다.
 *    (1) 사용자가 고른 "원문 백업 복구" — 바이트 수·SHA-256 검증 통과 시에만.
 *    (2) 사용자가 미리보기 후 누른 "서버 기록 가져오기" — 직전 원문을 별도 키에 자동 백업(SHA-256)한 뒤,
 *        앱의 기존 저장 경로(db.events 추가 → save())로 "추가만" 한다. 기존 기록은 수정·삭제하지 않고,
 *        가져온 기록에는 cloudId를 붙여 다시 올리지 않으며, 같은 서버 기록을 두 번 가져오지 않는다.
 *  - 원격에는 사용자가 미리보기 후 고른 복약·상태·생활 이벤트만 추가한다. 자유 메모·사용자 정의
 *    텍스트는 보내지 않는다. 약 목록·알림·질문·설정은 브라우저에 둔다.
 *  - 로컬 편집·삭제는 원격에 자동 전파하지 않고, 원격 기록은 별도 읽기 영역에만 보여준다.
 *  - 로그인 실패·오프라인·한도 초과여도 로컬 기록·조회는 그대로 동작한다(이 파일의 오류는 여기서 끝난다).
 *  - 세션 토큰은 sessionStorage(이 탭)에만 둔다. 공개 설정에는 Supabase URL과 publishable key만 있다.
 *  - 허용 값 목록은 supabase/migrations/*_diary_bridge.sql, workers/mcp/src/schema.ts와 같다
 *    (tests/bridge-schema-sync.test.js가 대조).
 */
(function(){
"use strict";

var LOCAL_KEY = "yakhyo_log_v1";
var ENABLED_KEY = "yakhyo_cloud_enabled_v1";
var IDMAP_KEY = "yakhyo_cloud_idmap_v1";
var UPLOAD_KEY_PREFIX = "yakhyo_cloud_upload_v1:";
var SESSION_KEY = "yakhyo_cloud_session_v1";
var BACKUP_FORMAT = "yakhyo-raw-backup";
var BACKUP_FORMAT_VERSION = 1;
var BATCH_SIZE = 100;
var IMPORT_BACKUP_KEY = "yakhyo_log_v1_before_cloud_import";

var SCHEMA = {
  STATE_VALUES: ["wake","off","rising","on","falling","signal","partial","dysk","dyst","wearoff"],
  TREND_VALUES: ["rising","stable","falling"],
  SYMPTOM_VALUES: ["dysk","dyst","tremor","freeze","rigid","pain","toecurl","gait_unstable"],
  LIFE_KINDS: ["sleep","meal","exercise","bowel","body"],
  LIFE_PHASES: ["start","end","nap"],
  MEAL_TYPES: ["아침","점심","저녁","간식"],
  MEAL_AMOUNTS: ["소량","보통","과식"],
  LIFE_EXTRAS: ["단백질 많음","기름진 식사","힘들었음","잔변감"],
  SLEEP_QUALITY: ["숙면","자주 깸","잠들기 어려움","REM 행동 의심"],
  EXERCISE_TYPES: ["걷기","실내자전거","근력","탁구","등산"],
  EXERCISE_INTENSITY: ["가벼움","보통","강함"],
  BOWEL_CONSISTENCY: ["딱딱함","보통","묽음"],
  BODY_SYMPTOMS: ["이상 없음","어지럼","기립 시 어지럼","소변 급박","빈뇨","땀 증가","침 흘림","메스꺼움","극심한 피로","불안","졸림","통증"]
};
var LEGACY_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

function tr(ko, en){ try{ return (typeof currentLang==="function" && currentLang()==="en") ? en : ko; }catch(e){ return ko; } }
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]; }); }
function cfg(){ var c = window.YAKHYO_CLOUD_CONFIG || {}; return { url: String(c.supabaseUrl||"").replace(/\/+$/,""), key: String(c.publishableKey||"") }; }
function configured(){ var c=cfg(); return /^https?:\/\//.test(c.url) && /^sb_publishable_/.test(c.key); }
function isEnabled(){ try{ return localStorage.getItem(ENABLED_KEY)==="1"; }catch(e){ return false; } }

/* ---------- 바이트·해시 ---------- */
function utf8Bytes(s){ return new TextEncoder().encode(s); }
function sha256Hex(s){
  var subtle = (window.crypto && window.crypto.subtle);
  if(!subtle) return Promise.reject(new Error("crypto.subtle unavailable"));
  return subtle.digest("SHA-256", utf8Bytes(s)).then(function(buf){
    return Array.prototype.map.call(new Uint8Array(buf), function(b){ return ("0"+b.toString(16)).slice(-2); }).join("");
  });
}

/* ---------- 원문 백업·복구 ---------- */
function makeRawBackup(){
  var raw = localStorage.getItem(LOCAL_KEY);
  if(raw==null) return Promise.reject(new Error("NO_LOCAL_DATA"));
  return sha256Hex(raw).then(function(h){
    return { format: BACKUP_FORMAT, format_version: BACKUP_FORMAT_VERSION, storage_key: LOCAL_KEY,
      created_at: new Date().toISOString(), byte_length: utf8Bytes(raw).length, sha256: h, raw: raw };
  });
}
/* 검증만 한다. 통과해야 restoreRawBackup이 쓴다. */
function verifyRawBackup(text){
  var b;
  try{ b = JSON.parse(text); }catch(e){ return Promise.resolve({ok:false, reason:"JSON_PARSE"}); }
  if(!b || b.format!==BACKUP_FORMAT) return Promise.resolve({ok:false, reason:"FORMAT"});
  if(b.format_version!==BACKUP_FORMAT_VERSION) return Promise.resolve({ok:false, reason:"FORMAT_VERSION"});
  if(b.storage_key!==LOCAL_KEY) return Promise.resolve({ok:false, reason:"STORAGE_KEY"});
  if(typeof b.raw!=="string") return Promise.resolve({ok:false, reason:"RAW_MISSING"});
  if(utf8Bytes(b.raw).length!==b.byte_length) return Promise.resolve({ok:false, reason:"BYTE_LENGTH"});
  return sha256Hex(b.raw).then(function(h){
    if(h!==b.sha256) return {ok:false, reason:"SHA256"};
    var d; try{ d=JSON.parse(b.raw); }catch(e){ return {ok:false, reason:"RAW_JSON"}; }
    if(!d || !Array.isArray(d.events)) return {ok:false, reason:"RAW_SHAPE"};
    return {ok:true, backup:b, eventCount:d.events.length};
  });
}
function restoreRawBackup(text){
  return verifyRawBackup(text).then(function(v){
    if(!v.ok) return v;
    localStorage.setItem(LOCAL_KEY, v.backup.raw);
    var back = localStorage.getItem(LOCAL_KEY);
    return back===v.backup.raw ? {ok:true, eventCount:v.eventCount} : {ok:false, reason:"WRITE_VERIFY"};
  });
}

/* ---------- 로컬 이벤트 → 원격 형식 (값을 추정해 채우지 않는다) ---------- */
function isNum(v){ return typeof v==="number" && isFinite(v); }
function inList(v, list){ return typeof v==="string" && list.indexOf(v)>=0; }
function sourceTz(){
  try{ var z=Intl.DateTimeFormat().resolvedOptions().timeZone; if(z && /^[A-Za-z0-9_+\/-]{1,64}$/.test(z)) return z; }catch(e){}
  return "Asia/Seoul";
}
function enumArray(v, list, max){
  if(v==null) return {ok:true, value:undefined};
  if(!Array.isArray(v)) return {ok:false};
  if(!v.length) return {ok:true, value:undefined};
  if(v.length>max) return {ok:false};
  for(var i=0;i<v.length;i++){ if(!inList(v[i], list)) return {ok:false}; }
  var uniq = v.filter(function(x,i){ return v.indexOf(x)===i; });
  return {ok:true, value:uniq};
}
/* 반환: {ok:true, kind, payload, excludedText:boolean} | {ok:false, reason} */
function convertEvent(e){
  if(!e || typeof e!=="object") return {ok:false, reason:"shape"};
  if(!isNum(e.ts) || e.ts < Date.UTC(2000,0,1) || e.ts > Date.now() + 86400000) return {ok:false, reason:"time"};
  var excluded = !!((e.memo && String(e.memo).trim()) || (e.customSymptom && String(e.customSymptom).trim()) || (e.exTypeCustom && String(e.exTypeCustom).trim()));
  var p = {}, a;
  if(e.type==="med"){
    var drug = typeof e.drug==="string" ? e.drug.trim() : "";
    if(!drug || drug.length>80 || /[\u0000-\u001f\u007f]/.test(drug)) return {ok:false, reason:"drug"};
    p.drug = drug;
    var d = e.dose;
    if(d===null || d===undefined || d==="") { /* 용량 없음 — 비워 둔다 */ }
    else if(isNum(d) && d>0 && d<=5000) p.dose_mg = d;
    else if(typeof d==="string" && /^\d+(\.\d+)?$/.test(d.trim()) && +d>0 && +d<=5000) p.dose_mg = +d;
    else return {ok:false, reason:"dose_unit"};
    return {ok:true, kind:"med", payload:p, excludedText:excluded};
  }
  if(e.type==="state"){
    if(!inList(e.state, SCHEMA.STATE_VALUES)) return {ok:false, reason:"state"};
    p.state = e.state;
    if(e.output!=null){ if(!isNum(e.output)||e.output<0||e.output>100) return {ok:false, reason:"output"}; p.output=e.output; }
    if(e.trend!=null){ if(!inList(e.trend, SCHEMA.TREND_VALUES)) return {ok:false, reason:"trend"}; p.trend=e.trend; }
    if(e.gait!=null){ if(!isNum(e.gait)||e.gait<0||e.gait>10) return {ok:false, reason:"gait"}; p.gait=e.gait; }
    if(e.dysk!=null){ if(!isNum(e.dysk)||e.dysk<0||e.dysk>10) return {ok:false, reason:"dysk"}; p.dysk=e.dysk; }
    a = enumArray(e.symptoms, SCHEMA.SYMPTOM_VALUES, 8); if(!a.ok) return {ok:false, reason:"symptoms"}; if(a.value) p.symptoms=a.value;
    return {ok:true, kind:"state", payload:p, excludedText:excluded};
  }
  if(e.type==="life"){
    if(!inList(e.kind, SCHEMA.LIFE_KINDS)) return {ok:false, reason:"life_kind"};
    p.kind = e.kind;
    if(e.phase!=null){ if(!inList(e.phase, SCHEMA.LIFE_PHASES)) return {ok:false, reason:"phase"}; p.phase=e.phase; }
    if(e.mealType!=null){ if(!inList(e.mealType, SCHEMA.MEAL_TYPES)) return {ok:false, reason:"meal_type"}; p.meal_type=e.mealType; }
    if(e.amount!=null){ if(!inList(e.amount, SCHEMA.MEAL_AMOUNTS)) return {ok:false, reason:"amount"}; p.amount=e.amount; }
    a = enumArray(e.extras, SCHEMA.LIFE_EXTRAS, 4); if(!a.ok) return {ok:false, reason:"extras"}; if(a.value) p.extras=a.value;
    a = enumArray(e.quality, SCHEMA.SLEEP_QUALITY, 4); if(!a.ok) return {ok:false, reason:"quality"}; if(a.value) p.quality=a.value;
    if(e.exType!=null){
      if(inList(e.exType, SCHEMA.EXERCISE_TYPES)) p.ex_type=e.exType;
      else if(e.exType==="기타") excluded = true; /* 사용자 정의 종류는 자유 텍스트 — 보내지 않음 */
      else return {ok:false, reason:"ex_type"};
    }
    if(e.intensity!=null){ if(!inList(e.intensity, SCHEMA.EXERCISE_INTENSITY)) return {ok:false, reason:"intensity"}; p.intensity=e.intensity; }
    if(e.durationMin!=null){ if(!isNum(e.durationMin)||e.durationMin<0||e.durationMin>1440||Math.round(e.durationMin)!==e.durationMin) return {ok:false, reason:"duration"}; p.duration_min=e.durationMin; }
    if(e.consistency!=null){ if(!inList(e.consistency, SCHEMA.BOWEL_CONSISTENCY)) return {ok:false, reason:"consistency"}; p.consistency=e.consistency; }
    a = enumArray(e.kind==="body" ? e.symptoms : null, SCHEMA.BODY_SYMPTOMS, 12); if(!a.ok) return {ok:false, reason:"body_symptoms"}; if(a.value) p.body_symptoms=a.value;
    return {ok:true, kind:"life", payload:p, excludedText:excluded};
  }
  return {ok:false, reason:"type"};
}

function canonicalJson(v){
  if(v===null || typeof v!=="object") return JSON.stringify(v);
  if(Array.isArray(v)) return "["+v.map(canonicalJson).join(",")+"]";
  return "{"+Object.keys(v).sort().map(function(k){ return JSON.stringify(k)+":"+canonicalJson(v[k]); }).join(",")+"}";
}
function readLocalDb(){
  try{ var d = JSON.parse(localStorage.getItem(LOCAL_KEY)); return (d && Array.isArray(d.events)) ? d : {events:[]}; }catch(e){ return {events:[]}; }
}
function readIdMap(){ try{ return JSON.parse(localStorage.getItem(IDMAP_KEY)) || {}; }catch(e){ return {}; } }

/* 로컬 분류: 범위 안의 med/state/life만. 원격 조회 없이 결정 가능한 것(ID 없음·ID 중복·변환 불가)을 먼저 가른다. */
function classifyLocal(events, fromMs, toMs){
  var inRange = events.filter(function(e){ return e && !e.cloudId && (e.type==="med"||e.type==="state"||e.type==="life") && isNum(e.ts) && e.ts>=fromMs && e.ts<toMs; });
  var idCount = {};
  events.forEach(function(e){ if(e && e.id!=null) { var k=String(e.id); idCount[k]=(idCount[k]||0)+1; } });
  var idmap = readIdMap();
  var out = { candidates:[], localConflict:[], invalid:[], needsId:[], excludedText:0 };
  return Promise.all(inRange.map(function(e){
    var conv = convertEvent(e);
    if(!conv.ok){ out.invalid.push({event:e, reason:conv.reason}); return null; }
    if(conv.excludedText) out.excludedText++;
    if(e.id==null || e.id===""){
      return sha256Hex(canonicalJson(e)).then(function(fp){
        if(idmap[fp]) out.candidates.push({event:e, legacy_id:idmap[fp], conv:conv});
        else out.needsId.push({event:e, fingerprint:fp, conv:conv});
      });
    }
    var id = String(e.id);
    if(idCount[id]>1){ out.localConflict.push({event:e, reason:"duplicate_local_id"}); return null; }
    if(!LEGACY_ID_RE.test(id)){ out.invalid.push({event:e, reason:"id_format"}); return null; }
    out.candidates.push({event:e, legacy_id:id, conv:conv});
    return null;
  })).then(function(){ return out; });
}
function toItem(c){
  return { legacy_id:c.legacy_id, kind:c.conv.kind, occurred_at:new Date(c.event.ts).toISOString(), source_tz:sourceTz(), payload:c.conv.payload };
}
/* ID가 없는 항목: 사용자가 확인한 뒤 별도 가져오기 목록에 안정적인 ID를 저장(원본은 건드리지 않음) */
function assignIds(needsId){
  var m = readIdMap();
  needsId.forEach(function(n){ if(!m[n.fingerprint]) m[n.fingerprint] = "noid-" + n.fingerprint.slice(0,24); });
  localStorage.setItem(IDMAP_KEY, JSON.stringify(m));
  return m;
}

/* ---------- 서버 기록 → 앱 기록 (가져오기) ---------- */
function arr(v){ return Array.isArray(v) ? v.slice() : []; }
/* 서버 행 → 앱의 기존 이벤트 모양(addMed/addState/addLife와 같은 필드). 값을 추정해 채우지 않는다. */
function remoteToLocal(row){
  var p = row && row.payload || {}, ts = Date.parse(row && row.occurred_at);
  if(!row || !row.id || !isFinite(ts)) return null;
  var base = { id:"cloud-"+row.id, ts:ts, memo:"", cloudId:row.id, cloudSource:row.source||null };
  if(row.kind==="med"){
    if(typeof p.drug!=="string" || !p.drug) return null;
    return Object.assign(base, { type:"med", drug:p.drug, dose:isNum(p.dose_mg)?p.dose_mg:null });
  }
  if(row.kind==="state"){
    if(SCHEMA.STATE_VALUES.indexOf(p.state)<0) return null;
    return Object.assign(base, { type:"state", state:p.state,
      output:isNum(p.output)?p.output:null, trend:p.trend||null, gait:isNum(p.gait)?p.gait:null, dysk:isNum(p.dysk)?p.dysk:null, dyst:null,
      symptoms:arr(p.symptoms), customSymptom:"", riseResult:null, inputMethod:"cloud_import", retrospective:true });
  }
  if(row.kind==="life"){
    if(SCHEMA.LIFE_KINDS.indexOf(p.kind)<0) return null;
    return Object.assign(base, { type:"life", kind:p.kind, phase:p.phase||null, mealType:p.meal_type||null, protein:false,
      quality:arr(p.quality), exType:p.ex_type||null, exTypeCustom:"", intensity:p.intensity||null,
      durationMin:isNum(p.duration_min)?p.duration_min:null, amount:p.amount||null, extras:arr(p.extras),
      consistency:p.consistency||null, firstToday:false, symptoms:arr(p.body_symptoms), customSymptom:"" });
  }
  return null;
}
function sameContent(a, b){
  if(a.type!==b.type || a.ts!==b.ts) return false;
  if(a.type==="med") return String(a.drug||"").trim()===String(b.drug||"").trim() && (a.dose==null?null:+a.dose)===(b.dose==null?null:+b.dose);
  if(a.type==="state") return a.state===b.state && (a.output==null?null:a.output)===(b.output==null?null:b.output);
  if(a.type==="life") return a.kind===b.kind && (a.phase||null)===(b.phase||null) && (a.mealType||null)===(b.mealType||null);
  return false;
}
/* 서버 행 분류: new(가져올 수 있음) / already(이미 이 기기에 있음) / dupe(같은 시각·내용 기록이 있어 확인 필요) / invalid */
function classifyRemote(rows, localEvents){
  var byId = {}, byCloud = {}, idmapVals = {};
  localEvents.forEach(function(e){ if(!e) return; if(e.id!=null) byId[String(e.id)] = true; if(e.cloudId) byCloud[e.cloudId] = true; });
  var m = readIdMap(); Object.keys(m).forEach(function(k){ idmapVals[m[k]] = true; });
  var out = { add:[], already:[], dupe:[], invalid:[] };
  rows.forEach(function(r){
    if(byCloud[r.id] || byId["cloud-"+r.id]) { out.already.push({row:r}); return; }
    if(r.source==="browser_upload" && r.legacy_id && (byId[r.legacy_id] || idmapVals[r.legacy_id])) { out.already.push({row:r}); return; }
    var ev = remoteToLocal(r);
    if(!ev){ out.invalid.push({row:r}); return; }
    if(localEvents.some(function(e){ return e && sameContent(e, ev); })) { out.dupe.push({row:r, ev:ev}); return; }
    out.add.push({row:r, ev:ev});
  });
  return out;
}
/* 앱 메모리의 db(index.html의 전역)와 저장 경로를 그대로 쓴다. 직전 원문은 별도 키에 백업. */
function importLocalEvents(evs){
  if(!evs.length) return Promise.resolve({ok:true, added:0});
  var appDb = (typeof db!=="undefined") ? db : null; // eslint-disable-line no-undef
  if(!appDb || !Array.isArray(appDb.events) || typeof save!=="function") return Promise.resolve({ok:false, reason:"APP_NOT_READY"}); // eslint-disable-line no-undef
  var have = {}; appDb.events.forEach(function(e){ if(e && e.cloudId) have[e.cloudId] = true; });
  var fresh = evs.filter(function(e){ return !have[e.cloudId]; });
  /* 실제로 추가할 것이 없으면 백업도 덮어쓰지 않는다(직전 가져오기의 되돌리기 지점을 지킨다). */
  if(!fresh.length) return Promise.resolve({ok:true, added:0});
  var raw = localStorage.getItem(LOCAL_KEY) || "";
  return sha256Hex(raw).then(function(h){
    try{ localStorage.setItem(IMPORT_BACKUP_KEY, JSON.stringify({ created_at:new Date().toISOString(), byte_length:utf8Bytes(raw).length, sha256:h, raw:raw })); }
    catch(e){ return {ok:false, reason:"BACKUP_FAILED"}; }
    fresh.forEach(function(e){ appDb.events.push(e); });
    appDb.events.sort(function(a,b){ return a.ts-b.ts; });
    save(); // eslint-disable-line no-undef
    try{ if(typeof renderAll==="function") renderAll(); }catch(e){} // eslint-disable-line no-undef
    var saved = []; try{ saved = JSON.parse(localStorage.getItem(LOCAL_KEY)).events; }catch(e){}
    var ok = fresh.every(function(e){ return saved.some(function(x){ return x.cloudId===e.cloudId; }); });
    return ok ? {ok:true, added:fresh.length} : {ok:false, reason:"WRITE_VERIFY"};
  });
}
/* 가져오기 직전 상태로 되돌리기(백업 검증 후). */
function undoImport(){
  var b; try{ b = JSON.parse(localStorage.getItem(IMPORT_BACKUP_KEY)); }catch(e){ b = null; }
  if(!b || typeof b.raw!=="string") return Promise.resolve({ok:false, reason:"NO_BACKUP"});
  return sha256Hex(b.raw).then(function(h){
    if(h!==b.sha256 || utf8Bytes(b.raw).length!==b.byte_length) return {ok:false, reason:"BACKUP_CORRUPT"};
    localStorage.setItem(LOCAL_KEY, b.raw);
    localStorage.removeItem(IMPORT_BACKUP_KEY);
    return {ok:true};
  });
}

/* ---------- 네트워크 ---------- */
function getSession(){ try{ return JSON.parse(sessionStorage.getItem(SESSION_KEY)); }catch(e){ return null; } }
function setSession(s){ if(s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); else sessionStorage.removeItem(SESSION_KEY); }
function netFetch(url, init){
  var ctrl = (typeof AbortController!=="undefined") ? new AbortController() : null;
  var t = ctrl ? setTimeout(function(){ ctrl.abort(); }, 10000) : null;
  init = init || {}; if(ctrl) init.signal = ctrl.signal;
  init.cache = "no-store";
  return fetch(url, init).finally(function(){ if(t) clearTimeout(t); });
}
function authCall(path, body){
  var c = cfg();
  return netFetch(c.url+"/auth/v1"+path, { method:"POST", headers:{ apikey:c.key, "content-type":"application/json" }, body:JSON.stringify(body) })
    .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ if(!r.ok) { var e=new Error("AUTH_"+r.status); e.status=r.status; throw e; } return j; }); });
}
function storeTokenResponse(j){
  var s = { access_token:j.access_token, refresh_token:j.refresh_token, expires_at:j.expires_at, user_id:j.user && j.user.id, email:j.user && j.user.email };
  setSession(s); return s;
}
function signIn(email, password){
  return authCall("/token?grant_type=password", {email:email, password:password}).then(storeTokenResponse).then(function(sess){
    /* 에이전트 전용 계정이면 알려 준다(서버도 승인·업로드를 막지만, 화면에서 먼저 안내). */
    /* 폐기·만료된 연결이어도 에이전트 계정이면 자기 연결 행은 보인다(RLS) → 그것으로 판별 */
    return api("GET", "/diary_agent_links?select=agent_id&agent_id=eq."+encodeURIComponent(sess.user_id)+"&limit=1").then(function(rows){
      sess.is_agent = !!(rows && rows.length); setSession(sess); return sess;
    }, function(){ return sess; });
  });
}
function ensureSession(){
  var s = getSession();
  if(!s) return Promise.reject(Object.assign(new Error("NO_SESSION"), {status:401}));
  if(s.expires_at && s.expires_at*1000 > Date.now()+60000) return Promise.resolve(s);
  return authCall("/token?grant_type=refresh_token", {refresh_token:s.refresh_token}).then(storeTokenResponse)
    .catch(function(e){ setSession(null); throw e; });
}
function signOut(){
  var s = getSession(), c = cfg(); setSession(null);
  if(!s || !configured()) return Promise.resolve();
  return netFetch(c.url+"/auth/v1/logout", { method:"POST", headers:{ apikey:c.key, authorization:"Bearer "+s.access_token } }).catch(function(){});
}
function api(method, path, body){
  return ensureSession().then(function(s){
    var c = cfg();
    return netFetch(c.url+"/rest/v1"+path, { method:method, headers:{ apikey:c.key, authorization:"Bearer "+s.access_token, "content-type":"application/json", accept:"application/json" }, body: body===undefined?undefined:JSON.stringify(body) })
      .then(function(r){ return r.text().then(function(t){ var j=null; try{ j=t?JSON.parse(t):null; }catch(e){}
        if(!r.ok){ var err=new Error((j&&j.message)||("HTTP_"+r.status)); err.status=r.status; throw err; } return j; }); });
  });
}
function errText(e){
  if(!e) return tr("알 수 없는 오류","Unknown error");
  if(e.name==="AbortError" || e.name==="TypeError") return tr("연결할 수 없어요. 로컬 기록은 그대로예요.","Can't connect. Local records still work.");
  if(e.status===401 || e.message==="NO_SESSION") return tr("로그인이 필요해요","Please sign in");
  if(e.status===400 && /AUTH_/.test(e.message)) return tr("이메일 또는 비밀번호를 확인하세요","Check email or password");
  if(e.status===403) return tr("권한이 없어요","Not allowed");
  if(e.status===409) return tr("같은 요청 키로 다른 내용이 이미 보내졌어요. 업로드 계획을 다시 만드세요.","Request key conflict. Rebuild the upload plan.");
  if(e.status===429) return tr("요청 한도를 넘었어요. 잠시 후 다시 시도하세요.","Rate limited. Try later.");
  if(e.status>=500) return tr("서버가 응답하지 않아요. 로컬 기록은 그대로예요.","Server unavailable. Local records still work.");
  return tr("요청이 실패했어요","Request failed");
}

/* ---------- 업로드 계획·실행(재개 가능) ---------- */
function uploadKey(uid){ return UPLOAD_KEY_PREFIX + uid; }
function readUpload(uid){ try{ return JSON.parse(localStorage.getItem(uploadKey(uid))) || null; }catch(e){ return null; } }
function writeUpload(uid, st){ localStorage.setItem(uploadKey(uid), JSON.stringify(st)); }
function randomKey(){
  var a = new Uint8Array(12); window.crypto.getRandomValues(a);
  return "imp-" + Array.prototype.map.call(a, function(b){ return ("0"+b.toString(16)).slice(-2); }).join("");
}
function makePlan(uid, items){
  var batches = [];
  for(var i=0;i<items.length;i+=BATCH_SIZE) batches.push({ request_key:randomKey(), items:items.slice(i,i+BATCH_SIZE), status:"pending", results:null });
  var st = { created_at:new Date().toISOString(), batches:batches };
  writeUpload(uid, st); return st;
}
/* 대기 중인 배치를 같은 요청 키·같은 항목으로 순서대로 보낸다. 중간 실패 시 그 지점에서 멈추고 다음에 재개. */
function runPlan(uid, onProgress){
  var st = readUpload(uid); if(!st) return Promise.resolve(null);
  var i = 0;
  function next(){
    while(i<st.batches.length && st.batches[i].status==="done") i++;
    if(i>=st.batches.length) return Promise.resolve(st);
    var b = st.batches[i];
    return api("POST", "/rpc/import_diary_events", { p_request_key:b.request_key, p_items:b.items }).then(function(res){
      b.status = "done"; b.results = res; delete b.error; writeUpload(uid, st);
      if(onProgress) onProgress(st);
      i++; return next();
    }, function(e){ b.status = "error"; b.error = e.status||"network"; writeUpload(uid, st); throw e; });
  }
  return next();
}
function summarizePlan(st){
  var s = {inserted:0, already:0, conflict:0, invalid:0, pending:0};
  (st && st.batches || []).forEach(function(b){
    if(b.status!=="done"){ s.pending += b.items.length; return; }
    (b.results||[]).forEach(function(r){ if(s[r.result]!=null) s[r.result]++; });
  });
  return s;
}

/* ---------- UI ---------- */
var ui = { preview:null, msg:"", busy:false };
function el(id){ return document.getElementById(id); }
function fmtKst(iso){
  var d = new Date(Date.parse(iso) + 9*3600000);
  function p(n){ return ("0"+n).slice(-2); }
  return d.getUTCFullYear()+"-"+p(d.getUTCMonth()+1)+"-"+p(d.getUTCDate())+" "+p(d.getUTCHours())+":"+p(d.getUTCMinutes());
}
function kindLabel(kind){ return kind==="med"?tr("복약","Medication"):kind==="state"?tr("상태","State"):kind==="life"?tr("생활","Daily life"):kind; }
/* 화면 표시는 앱의 기존 이름표(stateName·lifeLabel·tagLabel)를 그대로 쓴다. 저장 값은 바꾸지 않는다. */
function payloadText(kind, p){
  p = p || {};
  function st(k){ try{ return typeof stateName==="function" ? stateName(k) : k; }catch(e){ return k; } }
  function lf(k){ try{ return typeof lifeLabel==="function" ? lifeLabel(k) : k; }catch(e){ return k; } }
  function tg(k){ try{ return typeof tagLabel==="function" ? tagLabel(k) : k; }catch(e){ return k; } }
  var body;
  if(kind==="med") body = (p.drug||"") + (p.dose_mg!=null ? " "+p.dose_mg+"mg" : "");
  else if(kind==="state") body = st(p.state||"") + (p.output!=null ? " · "+tr("출력","output")+" "+p.output : "");
  else if(kind==="life"){
    var ph = p.phase==="nap" ? tr("낮잠","Nap") : p.phase==="start" ? (p.kind==="sleep"?tr("취침","Bedtime"):tr("시작","Start")) : p.phase==="end" ? (p.kind==="sleep"?tr("기상","Wake up"):tr("종료","End")) : null;
    body = [lf(p.kind), ph, p.meal_type&&tg(p.meal_type), p.ex_type&&tg(p.ex_type), p.amount&&tg(p.amount)].filter(Boolean).join(" · ");
  } else body = "";
  return kindLabel(kind) + " · " + body;
}
/* 결과는 카드 아래 상태줄과 함께 앱의 기존 토스트로도 알린다(누른 버튼에서 먼 곳만 바뀌면 반응을 놓친다). */
function setMsg(t){ ui.msg = t; var m = el("cbMsg"); if(m) m.textContent = t; try{ if(t && typeof toast==="function") toast(t.length>30 ? t.split(/\. |\(/)[0] : t); }catch(e){} } /* 토스트는 한 줄이라 첫 문장만, 전체 문장은 카드 상태줄에 */
function todayIso(offsetDays){ var d=new Date(Date.now()+9*3600000+(offsetDays||0)*86400000); return d.toISOString().slice(0,10); }
function kstStart(dateStr){ return Date.parse(dateStr+"T00:00:00+09:00"); }

function render(){
  var host = el("cloudBridgeCard"); if(!host) return;
  if(!configured()){
    host.innerHTML = '<div class="li"><div class="grow"><div class="name">'+tr("클라우드 연동 (시험)","Cloud sync (beta)")+'</div><div class="meta">'+tr("이 빌드에는 클라우드 설정이 없어 꺼져 있어요. 기록은 이 기기에만 저장됩니다.","Not configured in this build. Records stay on this device.")+'</div></div></div>' + backupRowHtml();
    bindBackup(); return;
  }
  var on = isEnabled(), s = getSession();
  var h = '<div class="li"><div class="grow"><div class="name">'+tr("클라우드 연동 (시험)","Cloud sync (beta)")+'</div><div class="meta">'+
    tr("켜고 로그인하면 미리보기에서 고른 복약·상태·생활 기록만 시험 서버(Supabase)에 저장할 수 있어요. 자동으로 보내지는 기록은 없고, 메모·약 목록·알림·설정은 보내지 않아요. 연결한 AI 에이전트는 여기 저장된 기록을 읽고 추가 요청을 보낼 수 있어요(확정은 승인할 때만. ④에서 '바로 기록'을 켠 AI는 한도 안에서 바로 기록되고 24시간 안에 ⑥에서 취소할 수 있어요). 로그인해 두면 AI 기록은 이 기기 기록에 자동으로 추가돼요.","When on and signed in, only the med/state/life records you pick in the preview can be stored on a test server (Supabase). Nothing is sent automatically; notes, med list, reminders and settings are never sent. A linked AI agent can read the stored records and send add requests (confirmed only when you approve, unless you turn on direct recording for that AI in ④ — undo within 24h in ⑥). While signed in, AI records are added to this device automatically.")+' <a href="privacy.html" target="_blank" rel="noopener">'+tr("개인정보 처리방침","Privacy policy")+'</a>'+
    '</div></div><button class="btn ghost" id="cbToggle" style="width:auto">'+(on?tr("끄기","Turn off"):tr("켜기","Turn on"))+'</button></div>';
  h += backupRowHtml();
  if(on){
    if(!s){
      h += '<div class="li" style="flex-wrap:wrap; gap:6px"><input id="cbEmail" type="email" autocomplete="username" placeholder="email" style="flex:1; min-width:140px">'+
        '<input id="cbPw" type="password" autocomplete="current-password" placeholder="password" style="flex:1; min-width:120px">'+
        '<button class="btn" id="cbLogin" style="width:auto">'+tr("로그인","Sign in")+'</button></div>';
    } else {
      h += '<div class="li"><div class="grow"><div class="meta">'+tr("로그인됨","Signed in")+': '+esc(s.email||"")+'</div></div><button class="btn ghost" id="cbLogout" style="width:auto">'+tr("로그아웃","Sign out")+'</button></div>';
      if(s.is_agent){
        h += '<div class="li" id="cbAgentNotice"><div class="grow"><div class="name">'+tr("이 계정은 AI 에이전트 전용이에요","This is an AI-agent-only account")+'</div><div class="meta">'+
          tr("승인·기록 올리기·연결 관리는 본인(사용자) 계정으로 로그인해야 해요. 로그아웃 후 다시 로그인하세요.","Approving, uploading and managing links need your own (user) account. Sign out and sign in again.")+'</div></div></div>';
        h += '<div class="meta" id="cbMsg" role="status" style="padding:8px 12px">'+esc(ui.msg)+'</div>';
        host.innerHTML = h; bindBackup();
        var lo0 = el("cbLogout"); if(lo0) lo0.onclick = function(){ signOut().then(function(){ setMsg(""); render(); }); };
        var t0 = el("cbToggle"); if(t0) t0.onclick = function(){ localStorage.removeItem(ENABLED_KEY); signOut(); render(); };
        return;
      }
      h += '<div class="li" style="flex-wrap:wrap; gap:6px"><div class="name" style="width:100%">'+tr("① 기록 올리기(미리보기 후 선택)","① Upload (preview first)")+'</div>'+
        '<input id="cbFrom" type="date" value="'+todayIso(-6)+'"> ~ <input id="cbTo" type="date" value="'+todayIso(0)+'">'+
        '<button class="btn ghost" id="cbPreview" style="width:auto">'+tr("미리보기","Preview")+'</button></div><div id="cbPreviewBox"></div>';
      h += '<div class="li" style="flex-wrap:wrap; gap:6px"><div class="name" style="width:100%">'+tr("② 에이전트 추가 요청 승인","② Approve agent requests")+'</div><button class="btn ghost" id="cbPending" style="width:auto">'+tr("요청 불러오기","Load requests")+'</button></div><div id="cbPendingBox"></div>';
      h += '<div class="li" style="flex-wrap:wrap; gap:6px"><div class="name" style="width:100%">'+tr("③ 공유된 기록 보기(원격, 읽기 전용)","③ Shared records (remote, read-only)")+'</div><input id="cbDay" type="date" value="'+todayIso(0)+'"><button class="btn ghost" id="cbRemote" style="width:auto">'+tr("보기","View")+'</button></div><div id="cbRemoteBox"></div>';
      h += '<div class="li" style="flex-wrap:wrap; gap:6px"><div class="name" style="width:100%">'+tr("④ 에이전트 연결","④ Agent links")+'</div><button class="btn ghost" id="cbLinks" style="width:auto">'+tr("연결 보기","Show links")+'</button></div><div id="cbLinksBox"></div>';
      h += '<div class="li" style="flex-wrap:wrap; gap:6px"><div class="name" style="width:100%">'+tr("⑤ 서버 기록 가져오기(내 앱 기록에 추가)","⑤ Import server records into this app")+'</div>'+
        '<input id="cbImpFrom" type="date" value="'+todayIso(-6)+'"> ~ <input id="cbImpTo" type="date" value="'+todayIso(0)+'">'+
        '<button class="btn ghost" id="cbImpPreview" style="width:auto">'+tr("미리보기","Preview")+'</button>'+
        (localStorage.getItem(IMPORT_BACKUP_KEY) ? '<button class="btn ghost" id="cbImpUndo" style="width:auto">'+tr("직전 가져오기 되돌리기","Undo last import")+'</button>' : '')+
        '</div><div id="cbImpBox"></div>';
      h += '<div class="li" style="flex-wrap:wrap; gap:6px"><div class="name" style="width:100%">'+tr("⑥ 바로 기록된 것(24시간 안 취소)","⑥ Direct records (undo within 24h)")+'</div><button class="btn ghost" id="cbAuto" style="width:auto">'+tr("목록 보기","Show")+'</button></div><div id="cbAutoBox"></div>';
    }
  }
  h += '<div class="meta" id="cbMsg" role="status" style="padding:8px 12px">'+esc(ui.msg)+'</div>';
  host.innerHTML = h;
  bindBackup();
  var t = el("cbToggle"); if(t) t.onclick = function(){
    if(on){ localStorage.removeItem(ENABLED_KEY); signOut(); }
    else if(confirm(tr("클라우드 연동(시험)을 켤까요? 켜도 자동으로 보내지는 기록은 없어요.","Turn on cloud sync (beta)? Nothing is sent automatically."))) localStorage.setItem(ENABLED_KEY, "1");
    render();
  };
  var lg = el("cbLogin"); if(lg) lg.onclick = function(){
    var em = el("cbEmail").value.trim(), pw = el("cbPw").value;
    el("cbPw").value = "";
    setMsg(tr("로그인 중…","Signing in…"));
    signIn(em, pw).then(function(){ setMsg(tr("로그인했어요","Signed in")); lastSync = 0; render(); }).catch(function(e){ setMsg(errText(e)); });
  };
  var lo = el("cbLogout"); if(lo) lo.onclick = function(){ signOut().then(function(){ setMsg(""); render(); }); };
  var pv = el("cbPreview"); if(pv) pv.onclick = doPreview;
  var pe = el("cbPending"); if(pe) pe.onclick = loadPending;
  var rm = el("cbRemote"); if(rm) rm.onclick = loadRemoteDay;
  var lk = el("cbLinks"); if(lk) lk.onclick = loadLinks;
  var au = el("cbAuto"); if(au) au.onclick = loadAutoEvents;
  if(on && s && !s.is_agent) syncAgentRecords(false);
  var ip = el("cbImpPreview"); if(ip) ip.onclick = previewImport;
  var iu = el("cbImpUndo"); if(iu) iu.onclick = function(){
    if(!confirm(tr("직전 '서버 기록 가져오기' 전 상태로 되돌릴까요? 그 뒤에 새로 적은 기록도 함께 사라집니다.","Restore the state before the last import? Records added after it will also be removed."))) return;
    undoImport().then(function(r){
      if(r.ok){ setMsg(tr("되돌렸어요. 화면을 새로 고칩니다.","Restored. Reloading.")); setTimeout(function(){ location.reload(); }, 300); }
      else setMsg(tr("되돌리지 못했어요","Could not undo")+" ("+r.reason+")");
    });
  };
}

function backupRowHtml(){
  return '<div class="li"><div class="grow"><div class="name">'+tr("원문 백업(복구용)","Raw backup (for restore)")+'</div><div class="meta">'+
    tr("이 기기의 기록 원문을 그대로 파일로 저장해요(바이트 수·SHA-256 포함). 서버로 보내지 않아요.","Saves the exact local data with byte count and SHA-256. Never uploaded.")+
    '</div></div><button class="btn ghost" id="cbRawExport" style="width:auto">'+tr("저장","Save")+'</button><button class="btn ghost" id="cbRawRestore" style="width:auto">'+tr("복구","Restore")+'</button>'+
    '<input type="file" id="cbRawFile" accept="application/json,.json,text/plain" style="display:none"></div>';
}
function bindBackup(){
  var ex = el("cbRawExport"); if(ex) ex.onclick = function(){
    makeRawBackup().then(function(b){
      var name = "yakhyo_raw_backup_"+b.created_at.replace(/[:.]/g,"-")+".json";
      var blob = new Blob([JSON.stringify(b)], {type:"application/json"});
      if(typeof saveFileSafely==="function") return saveFileSafely(blob, name, {title:name, mimeType:"application/json"});
      var a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=name; a.click();
    }).then(function(){ setMsg(tr("원문 백업 파일을 만들었어요","Raw backup created")); })
      .catch(function(e){ setMsg(e && e.message==="NO_LOCAL_DATA" ? tr("저장된 기록이 없어요","No local data") : tr("백업을 만들지 못했어요","Backup failed")); });
  };
  var rs = el("cbRawRestore"), f = el("cbRawFile");
  if(rs && f){
    rs.onclick = function(){ f.click(); };
    f.onchange = function(){
      var file = f.files[0]; f.value=""; if(!file) return;
      file.text().then(function(text){ return verifyRawBackup(text).then(function(v){
        if(!v.ok){ setMsg(tr("손상되었거나 올바르지 않은 백업이라 복구하지 않았어요","Backup invalid or corrupted — not restored")+" ("+v.reason+")"); return; }
        if(!confirm(tr("검증된 백업("+v.eventCount+"건)으로 이 기기의 기록을 덮어쓸까요?","Overwrite local records with verified backup ("+v.eventCount+" events)?"))) return;
        return restoreRawBackup(text).then(function(r){
          if(r.ok){ setMsg(tr("복구했어요. 화면을 새로 고칩니다.","Restored. Reloading.")); setTimeout(function(){ location.reload(); }, 300); }
          else setMsg(tr("복구 실패","Restore failed")+" ("+r.reason+")");
        });
      }); });
    };
  }
}

function doPreview(){
  var from = kstStart(el("cbFrom").value), to = kstStart(el("cbTo").value) + 86400000;
  var box = el("cbPreviewBox");
  if(!isFinite(from) || !isFinite(to) || to<=from){ setMsg(tr("날짜 범위를 확인하세요","Check the date range")); return; }
  setMsg(tr("미리보기 계산 중…","Building preview…"));
  classifyLocal(readLocalDb().events, from, to).then(function(local){
    var items = local.candidates.map(toItem);
    var chunks = []; for(var i=0;i<items.length;i+=500) chunks.push(items.slice(i,i+500));
    return Promise.all(chunks.map(function(ch){ return api("POST", "/rpc/preview_import_diary_events", {p_items:ch}); })).then(function(res){
      var flat = [].concat.apply([], res);
      var byId = {}; flat.forEach(function(r){ byId[r.legacy_id] = r.result; });
      var p = { add:[], already:[], conflict:local.localConflict.slice(), invalid:local.invalid.slice(), needsId:local.needsId, excludedText:local.excludedText };
      local.candidates.forEach(function(c, k){
        var r = byId[c.legacy_id];
        if(r==="new") p.add.push({c:c, item:items[k]});
        else if(r==="already") p.already.push(c);
        else if(r==="conflict") p.conflict.push(c);
        else p.invalid.push({event:c.event, reason:"server_invalid"});
      });
      ui.preview = p; renderPreview(box); setMsg("");
    });
  }).catch(function(e){ setMsg(errText(e)); });
}
function renderPreview(box){
  var p = ui.preview; if(!p || !box) return;
  var h = '<div class="meta" style="padding:6px 12px">'+
    tr("추가 가능","Can add")+' <b id="cbCntAdd">'+p.add.length+'</b> · '+tr("이미 등록","Already")+' <b id="cbCntAlready">'+p.already.length+'</b> · '+
    tr("충돌","Conflict")+' <b id="cbCntConflict">'+p.conflict.length+'</b> · '+tr("변환 불가","Cannot convert")+' <b id="cbCntInvalid">'+p.invalid.length+'</b>'+
    (p.needsId.length ? ' · '+tr("ID 없음","No ID")+' <b id="cbCntNoId">'+p.needsId.length+'</b>' : '')+
    (p.excludedText ? '<br>'+tr("메모·자유 텍스트는 보내지 않아요","Notes/free text are not sent")+' ('+p.excludedText+')' : '')+'</div>';
  if(p.add.length){
    h += '<div style="max-height:220px; overflow:auto; padding:0 12px">' + p.add.slice(0,500).map(function(x,i){
      return '<label style="display:block"><input type="checkbox" class="cbPick" data-i="'+i+'" checked> '+esc(fmtKst(x.item.occurred_at))+' · '+esc(payloadText(x.item.kind, x.item.payload))+'</label>';
    }).join("") + '</div><button class="btn" id="cbUpload" style="margin:6px 12px; width:auto">'+tr("선택한 기록 올리기","Upload selected")+'</button>';
  }
  if(p.needsId.length) h += '<button class="btn ghost" id="cbAssign" style="margin:6px 12px; width:auto">'+tr("ID 없는 "+p.needsId.length+"건에 ID 부여(확인)","Assign IDs to "+p.needsId.length+" items")+'</button>';
  box.innerHTML = h;
  var up = el("cbUpload"); if(up) up.onclick = function(){
    var picks = Array.prototype.filter.call(document.querySelectorAll(".cbPick"), function(c){ return c.checked; }).map(function(c){ return p.add[+c.dataset.i].item; });
    if(!picks.length) return;
    if(!confirm(tr(picks.length+"건을 시험 서버에 추가할까요? 로컬 기록은 바뀌지 않아요.","Add "+picks.length+" records to the test server? Local data is unchanged."))) return;
    var s = getSession(); if(!s) return;
    makePlan(s.user_id, picks);
    resumeUpload();
  };
  var as = el("cbAssign"); if(as) as.onclick = function(){
    if(!confirm(tr("ID가 없는 기록에 업로드용 ID를 부여할까요? 원본 기록은 바뀌지 않고 별도 목록에 저장돼요.","Assign upload IDs? Stored in a separate list; original data unchanged."))) return;
    assignIds(p.needsId); doPreview();
  };
}
function resumeUpload(){
  var s = getSession(); if(!s) return;
  setMsg(tr("올리는 중…","Uploading…"));
  runPlan(s.user_id, function(st){ var sm=summarizePlan(st); setMsg(tr("진행: 추가 ","Progress: added ")+sm.inserted+" · "+tr("남음 ","left ")+sm.pending); })
    .then(function(st){ var sm=summarizePlan(st); setMsg(tr("완료: 추가 "+sm.inserted+" · 이미 등록 "+sm.already+" · 충돌 "+sm.conflict+" · 변환 불가 "+sm.invalid,"Done: added "+sm.inserted+", already "+sm.already+", conflict "+sm.conflict+", invalid "+sm.invalid)); })
    .catch(function(e){ setMsg(errText(e)+" "+tr("(이어서 올리기 가능)","(resumable)")); renderResume(); });
}
function renderResume(){
  var box = el("cbPreviewBox"); if(!box) return;
  var b = document.createElement("button"); b.className="btn ghost"; b.id="cbResume"; b.style.cssText="margin:6px 12px; width:auto";
  b.textContent = tr("이어서 올리기","Resume upload"); b.onclick = resumeUpload; box.appendChild(b);
}

function loadPending(){
  var box = el("cbPendingBox");
  api("POST", "/rpc/list_my_pending_events", {}).then(function(rows){
    if(!rows || !rows.length){ box.innerHTML = '<div class="meta" style="padding:6px 12px">'+tr("대기 중인 요청이 없어요","No pending requests")+'</div>'; return; }
    box.innerHTML = rows.map(function(r){
      var dup = r.duplicate_event_id || r.duplicate_pending_count>0;
      return '<div class="li" data-pid="'+esc(r.id)+'"><div class="grow"><div class="name">'+esc(fmtKst(r.occurred_at))+' · '+esc(payloadText(r.kind, r.payload))+'</div>'+
        '<div class="meta">'+(r.status==="expired"?tr("만료됨","Expired"):tr("승인 대기","Pending"))+(dup?' · <b>'+tr("중복 후보","Possible duplicate")+'</b>':'')+'</div></div>'+
        (r.status==="pending" ? '<button class="btn ghost cbApprove" style="width:auto" data-id="'+esc(r.id)+'">'+tr("승인","Approve")+'</button><button class="btn ghost cbReject" style="width:auto" data-id="'+esc(r.id)+'">'+tr("거절","Reject")+'</button>' : '')+'</div>';
    }).join("");
    Array.prototype.forEach.call(box.querySelectorAll(".cbApprove"), function(b){ b.onclick = function(){ decide("approve_pending_event", b.dataset.id); }; });
    Array.prototype.forEach.call(box.querySelectorAll(".cbReject"), function(b){ b.onclick = function(){ decide("reject_pending_event", b.dataset.id); }; });
  }).catch(function(e){ setMsg(errText(e)); });
}
/* 승인한 기록을 이 기기 기록에도 바로 추가(같은 기록이 이미 있으면 건너뜀). 실패해도 승인은 유지되고 ⑤로 다시 가져올 수 있다. */
function addApprovedToLocal(eventId){
  if(typeof eventId!=="string" || !/^[0-9a-f-]{36}$/i.test(eventId)) return Promise.resolve({ok:false, reason:"NO_EVENT_ID"});
  return api("GET", "/diary_events?select=id,kind,occurred_at,payload,source,legacy_id&id=eq."+encodeURIComponent(eventId)).then(function(rows){
    var localEvents = (typeof db!=="undefined" && db && Array.isArray(db.events)) ? db.events : readLocalDb().events; // eslint-disable-line no-undef
    var c = classifyRemote(rows||[], localEvents);
    if(c.already.length || c.dupe.length) return {ok:true, added:0, skipped:true};
    return importLocalEvents(c.add.map(function(x){ return x.ev; }));
  }).catch(function(){ return {ok:false, reason:"FETCH"}; });
}
function decide(fn, id){
  api("POST", "/rpc/"+fn, {p_pending_id:id}).then(function(res){
    if(fn!=="approve_pending_event"){ setMsg(tr("거절했어요","Rejected")); loadPending(); return; }
    return addApprovedToLocal(res).then(function(r){
      setMsg(r.ok && r.added ? tr("승인했고 내 기록에 추가했어요","Approved and added to your records")
        : r.ok ? tr("승인했어요(같은 기록이 이미 있어 추가하지 않았어요)","Approved (same record already here)")
        : tr("승인했어요. 내 기록 추가는 ⑤ 서버 기록 가져오기로 해 주세요","Approved. Use ⑤ Import to add it to your records"));
      loadPending();
    });
  })
    .catch(function(e){ setMsg(e.status===410 ? tr("만료되었거나 이미 처리된 요청이에요","Expired or already decided") : errText(e)); loadPending(); });
}
function loadRemoteDay(){
  var d = el("cbDay").value, start = kstStart(d), box = el("cbRemoteBox");
  if(!isFinite(start)) return;
  api("GET", "/diary_events?select=id,kind,occurred_at,payload,source&occurred_at=gte."+encodeURIComponent(new Date(start).toISOString())+
    "&occurred_at=lt."+encodeURIComponent(new Date(start+86400000).toISOString())+"&order=occurred_at.asc,id.asc&limit=200").then(function(rows){
    box.innerHTML = (rows && rows.length) ? rows.map(function(r){
      return '<div class="li"><div class="grow"><div class="name">'+esc(fmtKst(r.occurred_at))+' · '+esc(payloadText(r.kind, r.payload))+'</div><div class="meta">'+(r.source==="agent_request"?tr("에이전트 요청 승인","Agent request"):r.source==="agent_auto"?tr("AI 바로 기록","AI direct"):tr("기기에서 올림","Uploaded"))+'</div></div></div>';
    }).join("") : '<div class="meta" style="padding:6px 12px">'+tr("공유된 기록이 없어요","No shared records")+'</div>';
  }).catch(function(e){ setMsg(errText(e)); });
}
var agentLabels = {};
function agentName(id){ return agentLabels[id] || (String(id||"").slice(0,8)+"…"); }
function fetchLinks(){
  var s = getSession();
  return api("GET", "/diary_agent_links?select=agent_id,label,scopes,expires_at,revoked_at,auto_write&owner_id=eq."+encodeURIComponent(s.user_id)+"&order=created_at.asc").then(function(rows){
    (rows||[]).forEach(function(r){ if(r.label) agentLabels[r.agent_id] = r.label; });
    return rows || [];
  });
}
function loadLinks(){
  var box = el("cbLinksBox");
  fetchLinks().then(function(rows){
    box.innerHTML = rows.length ? rows.map(function(r){
      var active = !r.revoked_at && Date.parse(r.expires_at) > Date.now();
      return '<div class="li" style="flex-wrap:wrap; gap:6px"><div class="grow"><div class="name">'+esc(agentName(r.agent_id))+'</div><div class="meta">'+
        (active ? tr("만료","Expires")+' '+esc(fmtKst(r.expires_at))+' · '+(r.auto_write?'<b>'+tr("바로 기록 켜짐","Direct record ON")+'</b>':tr("승인 후 기록","Approve first")) : (r.revoked_at?tr("폐기됨","Revoked"):tr("만료됨","Expired")))+'</div></div>'+
        (active ? '<button class="btn ghost cbAuto" style="width:auto" data-id="'+esc(r.agent_id)+'" data-on="'+(r.auto_write?"1":"0")+'">'+(r.auto_write?tr("바로 기록 끄기","Turn off direct"):tr("바로 기록 켜기","Turn on direct"))+'</button>'+
                  '<button class="btn danger cbRevoke" style="width:auto" data-id="'+esc(r.agent_id)+'">'+tr("연결 폐기","Revoke")+'</button>' : '')+'</div>';
    }).join("") : '<div class="meta" style="padding:6px 12px">'+tr("연결된 에이전트가 없어요","No agent links")+'</div>';
    Array.prototype.forEach.call(box.querySelectorAll(".cbRevoke"), function(b){ b.onclick = function(){
      if(!confirm(tr("이 에이전트 연결을 폐기할까요? 즉시 접근이 막혀요.","Revoke this agent link? Access stops immediately."))) return;
      api("POST", "/rpc/revoke_agent_link", {p_agent_id:b.dataset.id}).then(function(){ setMsg(tr("연결을 폐기했어요","Link revoked")); loadLinks(); }).catch(function(e){ setMsg(errText(e)); });
    }; });
    Array.prototype.forEach.call(box.querySelectorAll(".cbAuto"), function(b){ b.onclick = function(){
      var turnOn = b.dataset.on!=="1", name = agentName(b.dataset.id);
      if(turnOn && !confirm(tr(
        name+"에 '바로 기록'을 켤까요?\n\n· 이 AI의 요청이 승인 없이 바로 기록됩니다(복용 포함).\n· 다음은 자동으로 승인 대기로 보냅니다: 24시간보다 오래되거나 미래인 시각, 용량 없음·1000mg 초과, 같은 기록, 가까운 시각의 비슷한 기록(같은 약 30분·상태 10분), 1시간 20건 초과.\n· 바로 기록된 것은 24시간 안에 ⑥에서 취소할 수 있어요.\n· AI가 잘못 알아들은 내용도 그대로 들어갈 수 있어요.",
        "Turn on direct recording for "+name+"?\n\nIts requests (including medications) will be recorded without approval, except: times older than 24h or in the future, missing dose or >1000 mg, duplicates, similar records close in time, >20/hour — those still wait for approval. You can undo direct records within 24 hours in ⑥."))) return;
      api("POST", "/rpc/set_agent_auto_write", {p_agent_id:b.dataset.id, p_on:turnOn}).then(function(v){
        setMsg(v ? tr(name+": 바로 기록을 켰어요","Direct recording on") : tr(name+": 바로 기록을 껐어요(승인 후 기록)","Direct recording off")); loadLinks();
      }).catch(function(e){ setMsg(errText(e)); });
    }; });
  }).catch(function(e){ setMsg(errText(e)); });
}

/* ---------- ⑥ 바로 기록된 것(24시간 안 취소) ---------- */
function removeLocalByCloudId(cloudId){
  var appDb = (typeof db!=="undefined") ? db : null; // eslint-disable-line no-undef
  if(!appDb || !Array.isArray(appDb.events) || typeof save!=="function") return false; // eslint-disable-line no-undef
  var before = appDb.events.length;
  appDb.events = appDb.events.filter(function(e){ return !(e && e.cloudId===cloudId); });
  if(appDb.events.length===before) return false;
  save(); // eslint-disable-line no-undef
  try{ if(typeof renderAll==="function") renderAll(); }catch(e){} // eslint-disable-line no-undef
  return true;
}
function loadAutoEvents(){
  var box = el("cbAutoBox");
  fetchLinks().catch(function(){}).then(function(){ return api("POST", "/rpc/list_my_auto_events", {}); }).then(function(rows){
    box.innerHTML = (rows && rows.length) ? rows.map(function(r){
      return '<div class="li"><div class="grow"><div class="name">'+esc(fmtKst(r.occurred_at))+' · '+esc(payloadText(r.kind, r.payload))+'</div><div class="meta">'+
        esc(agentName(r.agent_id))+' · '+tr("취소 가능","Undo until")+' '+esc(fmtKst(r.undo_until))+'</div></div>'+
        '<button class="btn danger cbUndo" style="width:auto" data-id="'+esc(r.event_id)+'">'+tr("취소","Undo")+'</button></div>';
    }).join("") : '<div class="meta" style="padding:6px 12px">'+tr("최근 24시간 바로 기록된 것이 없어요","Nothing recorded directly in the last 24 hours")+'</div>';
    Array.prototype.forEach.call(box.querySelectorAll(".cbUndo"), function(b){ b.onclick = function(){
      if(!confirm(tr("이 기록을 취소할까요? 서버와 이 기기 기록에서 함께 지워져요.","Undo this record? It will be removed from the server and this device."))) return;
      api("POST", "/rpc/undo_auto_event", {p_event_id:b.dataset.id}).then(function(){
        removeLocalByCloudId(b.dataset.id); setMsg(tr("취소했어요","Undone")); loadAutoEvents();
      }).catch(function(e){
        if(e.status===404){ removeLocalByCloudId(b.dataset.id); setMsg(tr("이미 취소된 기록이에요","Already undone")); loadAutoEvents(); }
        else setMsg(e.status===410 ? tr("24시간이 지나 취소할 수 없어요","More than 24 hours passed") : errText(e));
      });
    }; });
  }).catch(function(e){ setMsg(errText(e)); });
}

/* ---------- 자동 받아오기: 로그인 상태에서 화면을 열거나 돌아올 때 AI 기록을 내 기록에 추가 ---------- */
var lastSync = 0, syncing = false;
var SYNC_MIN_GAP_MS = 5*60*1000;
function syncAgentRecords(force){
  var s = getSession();
  if(!configured() || !isEnabled() || !s || s.is_agent || syncing) return Promise.resolve(null);
  if(window.CLOUD_BRIDGE_NO_AUTOSYNC && !force) return Promise.resolve(null); /* 시험 도구 전용 */
  if(!force && Date.now()-lastSync < SYNC_MIN_GAP_MS) return Promise.resolve(null);
  syncing = true; lastSync = Date.now();
  var since = new Date(Date.now()-7*86400000).toISOString();
  return api("GET", "/diary_events?select=id,kind,occurred_at,payload,source,legacy_id&source=in.(agent_request,agent_auto)&created_at=gte."+encodeURIComponent(since)+"&order=occurred_at.asc,id.asc&limit=500").then(function(rows){
    var localEvents = (typeof db!=="undefined" && db && Array.isArray(db.events)) ? db.events : readLocalDb().events; // eslint-disable-line no-undef
    var c = classifyRemote(rows||[], localEvents);
    return importLocalEvents(c.add.map(function(x){ return x.ev; }));
  }).then(function(r){
    return api("POST", "/rpc/list_my_pending_events", {}).catch(function(){ return []; }).then(function(p){
      var n = (p||[]).filter(function(x){ return x.status==="pending"; }).length, parts = [];
      if(r && r.ok && r.added) parts.push(tr("AI 기록 "+r.added+"건을 내 기록에 추가했어요","Added "+r.added+" AI record(s)"));
      if(n) parts.push(tr("승인 대기 "+n+"건","Pending "+n));
      if(parts.length) setMsg(parts.join(" · "));
      return {added: r && r.added || 0, pending: n};
    });
  }).catch(function(){ return null; }).finally(function(){ syncing = false; });
}
try{ document.addEventListener("visibilitychange", function(){ if(document.visibilityState==="visible") syncAgentRecords(false); }); }catch(e){}

function previewImport(){
  var from = kstStart(el("cbImpFrom").value), to = kstStart(el("cbImpTo").value) + 86400000, box = el("cbImpBox");
  if(!isFinite(from) || !isFinite(to) || to<=from){ setMsg(tr("날짜 범위를 확인하세요","Check the date range")); return; }
  setMsg(tr("서버 기록을 확인하는 중…","Checking server records…"));
  api("GET", "/diary_events?select=id,kind,occurred_at,payload,source,legacy_id&occurred_at=gte."+encodeURIComponent(new Date(from).toISOString())+
    "&occurred_at=lt."+encodeURIComponent(new Date(to).toISOString())+"&order=occurred_at.asc,id.asc&limit=1000").then(function(rows){
    var localEvents = (typeof db!=="undefined" && db && Array.isArray(db.events)) ? db.events : readLocalDb().events; // eslint-disable-line no-undef
    var c = classifyRemote(rows||[], localEvents);
    ui.importPreview = c;
    var h = '<div class="meta" style="padding:6px 12px">'+tr("가져올 수 있음","Can import")+' <b id="cbImpCntAdd">'+c.add.length+'</b> · '+
      tr("이미 있음","Already here")+' <b id="cbImpCntAlready">'+c.already.length+'</b> · '+tr("중복 후보","Possible duplicate")+' <b id="cbImpCntDupe">'+c.dupe.length+'</b>'+
      (c.invalid.length ? ' · '+tr("변환 불가","Cannot convert")+' <b>'+c.invalid.length+'</b>' : '')+
      ((rows||[]).length>=1000 ? '<br>'+tr("기간이 길어 1,000건까지만 확인했어요. 기간을 나눠 주세요.","Only the first 1,000 checked — use a shorter range.") : '')+
      '<br>'+tr("가져오기 전 현재 기록을 자동 백업하고, 기존 기록은 바꾸지 않아요.","Current records are backed up first; existing records are never changed.")+'</div>';
    var list = c.add.map(function(x,i){ return {x:x, i:i, kind:"add"}; }).concat(c.dupe.map(function(x,i){ return {x:x, i:i, kind:"dupe"}; }));
    if(list.length){
      h += '<div style="max-height:220px; overflow:auto; padding:0 12px">'+list.map(function(o){
        return '<label style="display:block"><input type="checkbox" class="cbImpPick" data-k="'+o.kind+'" data-i="'+o.i+'"'+(o.kind==="add"?' checked':'')+'> '+
          esc(fmtKst(o.x.row.occurred_at))+' · '+esc(payloadText(o.x.row.kind, o.x.row.payload))+
          (o.kind==="dupe" ? ' <b>('+tr("같은 기록이 이미 있음","same record exists")+')</b>' : '')+
          (o.x.row.source==="agent_request" ? ' · '+tr("에이전트","agent") : '')+'</label>';
      }).join("")+'</div><button class="btn" id="cbImpRun" style="margin:6px 12px; width:auto">'+tr("선택한 기록 가져오기","Import selected")+'</button>';
    }
    box.innerHTML = h; setMsg("");
    var run = el("cbImpRun"); if(run) run.onclick = runImport;
  }).catch(function(e){ setMsg(errText(e)); });
}
function runImport(){
  var c = ui.importPreview; if(!c) return;
  var evs = Array.prototype.filter.call(document.querySelectorAll(".cbImpPick"), function(b){ return b.checked; })
    .map(function(b){ return (b.dataset.k==="add" ? c.add : c.dupe)[+b.dataset.i].ev; });
  if(!evs.length) return;
  if(!confirm(tr(evs.length+"건을 이 기기 기록에 추가할까요? 가져오기 전 상태는 자동 백업돼 되돌릴 수 있어요.","Add "+evs.length+" records to this device? A backup is kept so you can undo."))) return;
  importLocalEvents(evs).then(function(r){
    if(r.ok){ setMsg(tr(r.added+"건을 가져왔어요","Imported "+r.added)); ui.importPreview = null; render(); }
    else setMsg(tr("가져오지 못했어요","Import failed")+" ("+r.reason+")");
  });
}

window.CloudBridge = {
  syncAgentRecords:syncAgentRecords, removeLocalByCloudId:removeLocalByCloudId,
  SCHEMA:SCHEMA, LOCAL_KEY:LOCAL_KEY, ENABLED_KEY:ENABLED_KEY, IDMAP_KEY:IDMAP_KEY, SESSION_KEY:SESSION_KEY, UPLOAD_KEY_PREFIX:UPLOAD_KEY_PREFIX,
  configured:configured, isEnabled:isEnabled, sha256Hex:sha256Hex,
  makeRawBackup:makeRawBackup, verifyRawBackup:verifyRawBackup, restoreRawBackup:restoreRawBackup,
  convertEvent:convertEvent, classifyLocal:classifyLocal, toItem:toItem, assignIds:assignIds,
  signIn:signIn, signOut:signOut, api:api, makePlan:makePlan, runPlan:runPlan, readUpload:readUpload, summarizePlan:summarizePlan,
  remoteToLocal:remoteToLocal, classifyRemote:classifyRemote, importLocalEvents:importLocalEvents, undoImport:undoImport, IMPORT_BACKUP_KEY:IMPORT_BACKUP_KEY,
  render:render, _ui:ui
};
try{ if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", render); else render(); }catch(e){}
})();
