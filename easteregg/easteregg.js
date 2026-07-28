/* 토토 이스터에그 — 외부 라이브러리·저장소 접근 없음 */
(function(){
"use strict";
const img=document.getElementById("totoImg");
const emoji=document.getElementById("totoEmoji");
img.addEventListener("error",()=>{ img.hidden=true; emoji.hidden=false; }); /* 사진 없으면 🐶 */

/* 사진 터치 → 통통 애니메이션 + 짧은 "멍!" 합성음 (WebAudio, 실패해도 무시) */
const btn=document.getElementById("totoBtn");
let ctx=null;
function woofSound(){
  try{
    ctx=ctx||new (window.AudioContext||window.webkitAudioContext)();
    const t0=ctx.currentTime;
    [[520,0,.09],[300,.1,.14]].forEach(([f,dt,dur])=>{
      const o=ctx.createOscillator(), g=ctx.createGain();
      o.type="square"; o.frequency.setValueAtTime(f,t0+dt);
      o.frequency.exponentialRampToValueAtTime(f*0.6, t0+dt+dur);
      g.gain.setValueAtTime(.001,t0+dt);
      g.gain.exponentialRampToValueAtTime(.18,t0+dt+.02);
      g.gain.exponentialRampToValueAtTime(.001,t0+dt+dur);
      o.connect(g).connect(ctx.destination); o.start(t0+dt); o.stop(t0+dt+dur+.02);
    });
  }catch(e){}
}
btn.addEventListener("click",()=>{
  btn.classList.remove("woof"); void btn.offsetWidth; btn.classList.add("woof");
  woofSound();
});
})();
