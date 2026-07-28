/* ============================================================
   약효 비교 테스트 v2 — 타이머·알림 모듈 (challenge-timer.js)
   앱이 열려 있는 동안 setTimeout 기반 알림.
   AAB 네이티브 알림으로 교체할 수 있도록 notify()만 바꾸면 되는 구조.
   알림 실패·거부 시에도 시험 진행에는 영향 없음.
   ============================================================ */
(function(root){
"use strict";
const CHGTIMER = { _timers:[] };

CHGTIMER.STAGE_MINUTES = [30,60,90,120];

CHGTIMER.requestPermission = function(){
  try{
    if(typeof Notification==="undefined") return Promise.resolve("unsupported");
    if(Notification.permission==="granted") return Promise.resolve("granted");
    if(Notification.permission==="denied") return Promise.resolve("denied");
    return Notification.requestPermission();
  }catch(e){ return Promise.resolve("unsupported"); }
};

/* 교체 지점: 네이티브 브리지 사용 시 이 함수만 바꾼다 */
CHGTIMER.notify = function(title, body){
  try{
    if(typeof Notification!=="undefined" && Notification.permission==="granted"){
      new Notification(title,{body, tag:"med-challenge"}); return true;
    }
  }catch(e){}
  return false; /* 실패해도 호출측 화면 안내로 대체 */
};

/* doseTakenAt(ISO) 기준 경과 분 */
CHGTIMER.elapsedMin = function(doseTakenAtIso){
  const d=new Date(doseTakenAtIso); if(isNaN(d)) return null;
  return Math.round((Date.now()-d.getTime())/60000);
};

/* 다음 예정 시점과 놓친 시점 계산. doneStages: ["m30",...] */
CHGTIMER.dueInfo = function(doseTakenAtIso, doneStages){
  const el=CHGTIMER.elapsedMin(doseTakenAtIso);
  if(el==null) return {elapsed:null, next:null, missed:[]};
  const done=new Set(doneStages||[]);
  const missed=[], GRACE=15; /* 예정+15분 지나면 '놓친 기록' */
  let next=null;
  CHGTIMER.STAGE_MINUTES.forEach(m=>{
    const st="m"+m;
    if(done.has(st)) return;
    if(el>m+GRACE) missed.push({stage:st, minutes:m});
    else if(!next) next={stage:st, minutes:m, inMin:Math.max(0,m-el)};
  });
  return {elapsed:el, next, missed};
};

CHGTIMER.clear = function(){ CHGTIMER._timers.forEach(id=>clearTimeout(id)); CHGTIMER._timers=[]; };

/* 열려 있는 동안 각 시점 알림 예약. onDue(stage,minutes)는 화면 갱신 콜백 */
CHGTIMER.schedule = function(doseTakenAtIso, doneStages, onDue){
  CHGTIMER.clear();
  const el=CHGTIMER.elapsedMin(doseTakenAtIso);
  if(el==null) return;
  const done=new Set(doneStages||[]);
  CHGTIMER.STAGE_MINUTES.forEach(m=>{
    const st="m"+m;
    if(done.has(st) || el>=m) return;
    const id=setTimeout(()=>{
      CHGTIMER.notify("약효 비교 테스트", `복용 ${m}분 기록 시간입니다`);
      if(onDue) try{ onDue(st,m); }catch(e){}
    }, (m-el)*60000);
    CHGTIMER._timers.push(id);
  });
};

if(typeof module!=="undefined"&&module.exports) module.exports=CHGTIMER;
root.CHGTIMER=CHGTIMER;
})(typeof window!=="undefined"?window:globalThis);
