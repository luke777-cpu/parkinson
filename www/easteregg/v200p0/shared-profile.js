/* ============================================================
   Shared Profile — 본체 ↔ Medication Challenge 데이터 전달 (v0.9.21)
   키: parkinsonSharedProfileV1
   원칙: 본체 DB(yakhyo_log_v1)와 챌린지 DB(medicationChallengeDbV2)를
   서로 직접 수정하지 않고, 이 프로필을 통해서만 전달한다.
   ============================================================ */
(function(root){
"use strict";
const SHARED = {};
SHARED.KEY = "parkinsonSharedProfileV1";

SHARED.empty = () => ({
  version:1,
  language:"ko",
  fontScale:1,            /* 1 / 1.15 / 1.3 (v0.9.20 글씨 크기) */
  zoomEnabled:true,
  primarySymptoms:[],     /* 본체 주증상 [{type,active,label?}] */
  medications:[],         /* 본체 약 목록 사본 [{name,dose,sched[],note}] — 읽기 전용 전달용 */
  challengeSummaries:[],  /* 챌린지 → PHS용 최근 완료 시험 요약 (최대 5) */
  pendingDiaryEvents:[],  /* 챌린지 → 본체 이벤트 전달 큐 (본체가 편입 후 비움) */
  updatedAt:"",
});

SHARED.read = function(){
  try{ const raw=localStorage.getItem(SHARED.KEY);
    if(raw){ const d=JSON.parse(raw); if(d&&d.version===1) return {...SHARED.empty(), ...d}; } }catch(e){}
  return SHARED.empty();
};
SHARED.write = function(patch){
  try{
    const cur=SHARED.read();
    const next={...cur, ...patch, version:1, updatedAt:new Date().toISOString()};
    localStorage.setItem(SHARED.KEY, JSON.stringify(next));
    return next;
  }catch(e){ return null; }
};

/* 챌린지 → 본체: 완료 시험을 약효일지 이벤트로 보내기 (사용자가 선택했을 때만) */
SHARED.pushDiaryEvent = function(ev){
  const cur=SHARED.read();
  cur.pendingDiaryEvents=(cur.pendingDiaryEvents||[]).concat([ev]).slice(-20);
  return SHARED.write({pendingDiaryEvents:cur.pendingDiaryEvents});
};
/* 본체 편입 절차: peek → 본체 저장 성공 확인 → remove (실패 시 큐 유지) */
SHARED.peekDiaryEvents = function(){ return SHARED.read().pendingDiaryEvents||[]; };
SHARED.removeDiaryEvents = function(ids){
  const set=new Set(ids||[]);
  const cur=SHARED.read();
  const left=(cur.pendingDiaryEvents||[]).filter(e=>!set.has(e.challengeTestId));
  return SHARED.write({pendingDiaryEvents:left});
};
/* (구버전 호환) 큐를 반환하고 비운다 */
SHARED.drainDiaryEvents = function(){
  const q=SHARED.peekDiaryEvents();
  if(q.length) SHARED.write({pendingDiaryEvents:[]});
  return q;
};
/* 챌린지 완료 시 PHS용 요약 저장 (언어중립 코드값) */
SHARED.putChallengeSummary = function(sum){
  const cur=SHARED.read();
  const list=(cur.challengeSummaries||[]).filter(s=>s.id!==sum.id);
  list.push(sum);
  list.sort((a,b)=>String(a.date).localeCompare(String(b.date)));
  return SHARED.write({challengeSummaries:list.slice(-5)});
};

if(typeof module!=="undefined"&&module.exports) module.exports=SHARED;
root.SHARED=SHARED;
})(typeof window!=="undefined"?window:globalThis);
