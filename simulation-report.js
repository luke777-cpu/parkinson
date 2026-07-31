/* ============================================================
   simulation-report.js — Parkinson Medication Simulation Platform v1.0
   책임: engine/compare/interpret가 만든 결과를 화면(HTML/SVG)으로 조립한다.
   이 파일은 계산을 하지 않는다 — 숫자를 다시 만들지 않고 받은 것만 그린다.
   ============================================================ */
(function(root){
"use strict";
const REP = {};

function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function fmtT(tMin){ if(tMin==null) return "도달하지 못함(예상)"; const t=((tMin%1440)+1440)%1440; const h=Math.floor(t/60), m=Math.round(t%60); return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`; }
function fmtDur(mins){ mins=Math.round(mins); if(mins>=60) return `${Math.floor(mins/60)}시간 ${mins%60?mins%60+"분":""}`.trim(); return `${mins}분`; }

/* 단일 출력 곡선(0~100) SVG — 실제(점)/현재안(실선)/실험안(점선) 중 있는 것만 그림 */
REP.outputSvg = function(opts){
  const {t0, t1, actual, baselineExpected, scenarioExpected, W, H} = Object.assign({W:700,H:170}, opts);
  const padL=32,padR=10,padT=8,padB=22, plotW=W-padL-padR, plotH=H-padT-padB;
  const x=t=>padL+(t-t0)/(t1-t0)*plotW;
  const y=v=>padT+plotH-(Math.min(100,Math.max(0,v))/100)*plotH;
  const line=(pts)=>pts.map(p=>`${x(p.t)},${y(p.val)}`).join(" ");
  const axisLbl=[0,20,50,80,100].map(p=>`<text x="${padL-6}" y="${y(p)+3}" font-size="8.5" fill="var(--ink-2)" text-anchor="end">${p}</text>`).join("");
  const band=`<line x1="${padL}" y1="${y(80)}" x2="${W-padR}" y2="${y(80)}" stroke="#1FA971" stroke-width="0.8" stroke-dasharray="2,3" opacity="0.55"/>`;
  let s=`<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block">${axisLbl}${band}`;
  if(baselineExpected&&baselineExpected.length) s+=`<polyline points="${line(baselineExpected)}" fill="none" stroke="#5C93D6" stroke-width="2"/>`;
  if(scenarioExpected&&scenarioExpected.length) s+=`<polyline points="${line(scenarioExpected)}" fill="none" stroke="#E0A030" stroke-width="2" stroke-dasharray="6,4"/>`;
  if(actual&&actual.length){
    s+=actual.map(p=>`<circle cx="${x(p.t)}" cy="${y(p.val)}" r="3.4" fill="#E8663C"/>`).join("");
    if(actual.length>1) s+=`<polyline points="${line(actual)}" fill="none" stroke="#E8663C" stroke-width="1.2" stroke-dasharray="1,3"/>`;
  }
  s+="</svg>";
  return s;
};

/* 종합 비교 그래프: 실제 + 현재안 + 실험안 최대 3개 겹침 */
REP.combinedSvg = function(opts){
  const {t0,t1,actual,baselineExpected,scenarios,W,H} = Object.assign({W:700,H:190}, opts);
  const colors=["#E0A030","#7B5CD6","#1FA971"];
  const padL=32,padR=10,padT=8,padB=30, plotW=W-padL-padR, plotH=H-padT-padB;
  const x=t=>padL+(t-t0)/(t1-t0)*plotW;
  const y=v=>padT+plotH-(Math.min(100,Math.max(0,v))/100)*plotH;
  const line=(pts)=>pts.map(p=>`${x(p.t)},${y(p.val)}`).join(" ");
  const axisLbl=[0,20,50,80,100].map(p=>`<text x="${padL-6}" y="${y(p)+3}" font-size="8.5" fill="var(--ink-2)" text-anchor="end">${p}</text>`).join("");
  let s=`<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block">${axisLbl}`;
  if(baselineExpected&&baselineExpected.length) s+=`<polyline points="${line(baselineExpected)}" fill="none" stroke="#5C93D6" stroke-width="2.2"/>`;
  (scenarios||[]).forEach((sc,i)=>{ if(sc&&sc.length) s+=`<polyline points="${line(sc)}" fill="none" stroke="${colors[i%colors.length]}" stroke-width="1.8" stroke-dasharray="6,4"/>`; });
  if(actual&&actual.length){
    s+=actual.map(p=>`<circle cx="${x(p.t)}" cy="${y(p.val)}" r="3.4" fill="#E8663C"/>`).join("");
    if(actual.length>1) s+=`<polyline points="${line(actual)}" fill="none" stroke="#E8663C" stroke-width="1.2" stroke-dasharray="1,3"/>`;
  }
  s+="</svg>";
  return s;
};

/* 실험안 1개의 결과 카드 표 (실제/현재안/실험안 항목 비교) */
REP.metricsTableHtml = function(baselineMetrics, scenarioMetrics, diff){
  const row=(label,a,b)=>`<tr><td style="padding:3px 6px; color:var(--ink-2)">${label}</td><td style="padding:3px 6px; text-align:right">${a}</td><td style="padding:3px 6px; text-align:right; font-weight:800">${b}</td></tr>`;
  return `<table style="width:100%; font-size:12px; border-collapse:collapse">
    <tr><td></td><td style="text-align:right; color:var(--ink-2)">현재안</td><td style="text-align:right; color:var(--ink-2)">실험안</td></tr>
    ${row("예상 ON 도달", fmtT(baselineMetrics.onT), fmtT(scenarioMetrics.onT))}
    ${row("최고 예상 출력", baselineMetrics.peak?Math.round(baselineMetrics.peak.val):"–", scenarioMetrics.peak?Math.round(scenarioMetrics.peak.val):"–")}
    ${row("80 이상 유지", fmtDur(baselineMetrics.dwell80), fmtDur(scenarioMetrics.dwell80))}
    ${row("50~79 체류", fmtDur(baselineMetrics.dwell5079), fmtDur(scenarioMetrics.dwell5079))}
    ${row("20 미만 체류", fmtDur(baselineMetrics.dwellLow), fmtDur(scenarioMetrics.dwellLow))}
    ${row("wearing-off", fmtT(baselineMetrics.wearT), fmtT(scenarioMetrics.wearT))}
    ${row("Incomplete ON 가능성", baselineMetrics.incomplete?"가능성 있음":"—", scenarioMetrics.incomplete?"가능성 있음":"—")}
  </table>`;
};

/* 실험안 카드 전체(펼치기 내부) — 그래프 3개 + 표 + 해석 문단 */
REP.scenarioDetailHtml = function(scenario, baselineComputed, diff, interpretation){
  const c=scenario.computed;
  const actualPts=(scenario.actualSorted||[]).map(p=>({t:p.t,val:p.val}));
  return `
    <div style="margin-top:8px">
      <div style="font-size:11.5px; color:var(--ink-2); margin-bottom:2px">① 선택일 실제 출력</div>
      ${REP.outputSvg({t0:c.t0,t1:c.t1,actual:actualPts})}
      <div style="font-size:11.5px; color:var(--ink-2); margin:6px 0 2px">② 현재안 예상 출력</div>
      ${REP.outputSvg({t0:c.t0,t1:c.t1,baselineExpected:baselineComputed.expected})}
      <div style="font-size:11.5px; color:var(--ink-2); margin:6px 0 2px">③ ${esc(scenario.title)} 예상 출력</div>
      ${REP.outputSvg({t0:c.t0,t1:c.t1,scenarioExpected:c.expected})}
      <div style="margin-top:8px">${REP.metricsTableHtml(baselineComputed.metrics, c.metrics, diff)}</div>
      <div style="font-size:12.5px; line-height:1.7; margin-top:8px; padding:8px 10px; background:var(--surface-2); border-radius:8px">${esc(interpretation.text)}</div>
      ${interpretation.cautions.length? `<div style="font-size:11.5px; color:var(--danger); margin-top:4px">${interpretation.cautions.map(esc).join(" · ")}</div>`:""}
    </div>`;
};

if(typeof module!=="undefined"&&module.exports) module.exports=REP;
root.SIMREP=REP;
})(typeof window!=="undefined"?window:globalThis);
