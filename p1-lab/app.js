'use strict';
const $=id=>document.getElementById(id),C=P1,KEY='p1-lab-v1';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const names=['퍼킨 CR','퍼킨','미라펙스 ER','아만타딘','아질렉트','마도파 확산정'];
SIMDRUG.DRUGS.find(d=>d.curveId==='LEVO_HBS').aliases.push('퍼킨 CR');
let state=C.defaults(),blocked=false,lastDeleted=null,editing=null,timer;
try{const raw=localStorage.getItem(KEY);if(raw)state=C.validate(JSON.parse(raw));}catch(e){blocked=true;$('storageWarning').classList.remove('hidden');$('storageWarning').textContent='기존 저장 자료를 읽을 수 없습니다. 덮어쓰기를 막았습니다. 백업 파일을 복원하거나 다른 브라우저에서 시작하세요.';}
const toast=s=>{$('toast').textContent=s;$('toast').classList.remove('hidden');clearTimeout(timer);timer=setTimeout(()=>$('toast').classList.add('hidden'),5000);};
function save(next=state){if(blocked){toast('저장 차단 상태입니다. 백업 복원을 먼저 확인하세요.');return false;}try{C.validate(next);localStorage.setItem(KEY,JSON.stringify(next));state=next;$('storageStatus').textContent='이 브라우저에 저장됨';return true;}catch(e){toast('저장하지 못했습니다. 저장 공간 또는 입력값을 확인하고 백업하세요.');return false;}}
function commitEvent(e){const next=structuredClone(state);const i=next.events.findIndex(x=>x.id===e.id);if(i>=0)next.events[i]=e;else next.events.push(e);return save(next);}
const selected=()=>$('day').value;
const dayEvents=()=>state.events.filter(e=>e.day===selected()).sort((a,b)=>a.minute-b.minute);
function validTime(day,minute){const now=new Date();return day<C.day(now)||(day===C.day(now)&&minute<=C.minute(now));}
function baseEvent(type,time){return {id:C.id(),type,day:selected(),minute:C.toMinute(time),createdAt:new Date().toISOString(),note:''};}
function plot(){
 const doses=$('curveMode').value==='plan'?state.schedule:dayEvents().filter(e=>e.type==='med').map(e=>({...e,time:C.clock(e.minute)}));
 const curve=SIMDRUG.compositeCurve(doses,360,1439,5);const W=1060,H=355,L=48,R=25,T=30,B=48;
 const x=t=>L+(t-360)/1080*(W-L-R),y=v=>H-B-v/100*(H-B-T);
 const path=pts=>pts.map((p,i)=>`${i?'L':'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
 let parts=[`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="약물 지수, 평소 출력, 실제 출력과 예측을 비교한 하루 그래프"><rect width="1060" height="355" fill="white"/>`];
 for(const [a,b] of [[600,720],[1320,1380]])parts.push(`<rect x="${x(a)}" y="${T}" width="${x(b)-x(a)}" height="${H-B-T}" fill="#f2edf9"/>`);
 for(let v=0;v<=100;v+=20)parts.push(`<line x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}" stroke="#e2ebe6"/><text x="${L-12}" y="${y(v)+5}" text-anchor="end" font-size="13" fill="#556c65">${v}</text>`);
 for(let t=360;t<=1440;t+=120)parts.push(`<text x="${x(t)}" y="${H-16}" text-anchor="middle" font-size="14" fill="#536b62">${C.clock(t)}</text>`);
 parts.push(`<path d="${path(curve.points.map(p=>({t:p.t,v:p.val})))}" fill="none" stroke="#247697" stroke-width="3"/>`);
 let segment=[];for(const p of [...state.baseline,{t:1440,v:null}]){if(p.v===null){if(segment.length>1)parts.push(`<path d="${path(segment)}" fill="none" stroke="#cf773b" stroke-width="2.5" stroke-dasharray="7 5"/>`);segment=[];}else segment.push(p);}
 const outputs=dayEvents().filter(e=>e.type==='output'&&e.minute>=360);
 outputs.forEach((e,i)=>{const a=outputs[i-1];if(a&&e.minute-a.minute<=120)parts.push(`<path d="${path([{t:a.minute,v:a.value},{t:e.minute,v:e.value}])}" stroke="#167255" stroke-width="3" fill="none"/>`);parts.push(`<circle cx="${x(e.minute)}" cy="${y(e.value)}" r="5" fill="#167255"><title>${C.clock(e.minute)} 출력 ${e.value}</title></circle>`);});
 const forecasts=state.forecasts.filter(f=>f.day===selected()).slice(-12);forecasts.forEach(f=>parts.push(`<path d="M${x(f.targetMinute)},${y(f.value)-6}l6,6 -6,6 -6,-6z" fill="#8871b3"><title>${C.clock(f.targetMinute)} 예측 ${f.value} (${f.method})</title></path>`));
 const meds=dayEvents().filter(e=>e.type==='med'&&e.minute>=360);meds.forEach(e=>parts.push(`<line x1="${x(e.minute)}" x2="${x(e.minute)}" y1="${H-B}" y2="${H-B+8}" stroke="#193e38" stroke-width="2"><title>${esc(e.name)} ${e.dose}mg ${C.clock(e.minute)}</title></line>`));
 dayEvents().filter(e=>e.type==='factor'&&e.factor==='이상운동증'&&e.minute>=360).forEach(e=>parts.push(`<circle cx="${x(e.minute)}" cy="${T+8}" r="5" fill="#ad5498"><title>실제 이상운동증 기록 ${C.clock(e.minute)}</title></circle>`));
 parts.push('</svg>');$('chart').innerHTML=parts.join('');
 $('curveNote').textContent=($('curveMode').value==='plan'?'파란선은 표준표대로 복용했다고 가정합니다. 실제 복용 확인과 다릅니다.':'파란선은 해당 날짜 확인된 약만 반영합니다. 배경약은 반복 복용 누적 가정을 유지합니다.')+' 06시 이전 기록은 목록에 표시합니다. 점심·저녁 변경은 실제 복약으로 기록하세요.';
}
function renderMeds(){
 $('meds').innerHTML=state.schedule.map(m=>{
  const done=dayEvents().filter(e=>e.type==='med'&&e.slot===m.id);
  return `<div class="medrow"><div><strong>${esc(m.time)} · ${esc(m.name)}</strong><p>${m.dose}mg</p>${done.length?`<small>기록됨: ${done.map(e=>C.clock(e.minute)+' · '+e.dose+'mg').join(', ')}</small>`:'<small>미확인</small>'}</div><button data-slot="${esc(m.id)}" ${done.length?'disabled':''}>${done.length?'기록 완료':'복용 기록'}</button></div>`;
 }).join('');
}
function renderEvents(){
 const ev=dayEvents();$('events').innerHTML=ev.length?ev.map(e=>`<div class="eventrow"><div><strong>${C.clock(e.minute)} · ${esc(e.type==='output'?'출력 '+e.value:e.type==='med'?e.name+' '+e.dose+'mg':e.factor+(e.severity?' · '+e.severity:''))}</strong><p class="muted">${esc(e.note)}</p></div><div class="row"><button data-edit="${esc(e.id)}">수정</button><button data-delete="${esc(e.id)}">삭제</button></div></div>`).join(''):'<p class="empty">실제 기록이 아직 없습니다.</p>';
 const last=ev.filter(e=>e.type==='output').at(-1);$('latest').textContent=last?`마지막 기록 ${C.clock(last.minute)} · 출력 ${last.value}`:'표준 점수는 실제 기록으로 자동 저장되지 않습니다.';
}
function metrics(){
 const out=dayEvents().filter(e=>e.type==='output');const deltas=out.flatMap(e=>{const b=C.base(state.baseline,e.minute);return b===null?[]:[e.value-b];});
 const avg=a=>a.length?Math.round(a.reduce((s,v)=>s+v,0)/a.length):null;
 const delta=avg(deltas);$('dailyMetrics').innerHTML=metric('실제 출력 기록',out.length+'회')+metric('기록한 출력 평균',out.length?avg(out.map(e=>e.value)):'—')+metric('평소 대비 차이',delta===null?'—':(delta>0?'+':'')+delta);
 $('dailyDetails').innerHTML='<p class="muted">기록한 시점만 비교합니다. 하루 전체 평균이나 ON 시간은 아닙니다. 평소 값이 없는 구간은 차이 계산에서 제외합니다.</p>';
 const changes=dayEvents().filter(e=>e.type==='med'&&e.slot).flatMap(e=>{const p=state.schedule.find(x=>x.id===e.slot);if(!p)return [];const dt=e.minute-C.toMinute(p.time);return dt||p.dose!==e.dose?[`${e.name}: 현재 표준표보다 ${dt>=0?dt+'분 늦게':-dt+'분 일찍'}, ${e.dose}mg`]:[];});
 if(changes.length)$('dailyDetails').innerHTML+='<h3>표준표와 다른 복약</h3><ul>'+changes.map(t=>'<li>'+esc(t)+'</li>').join('')+'</ul>';
 $('associations').innerHTML='<div class="tablewrap"><table><tr><th>요인</th><th>기록 있는 날</th><th>미기록일</th><th>평소 대비 차이의 집단 차이</th></tr>'+C.associations(state).map(a=>`<tr><td>${a.factor}</td><td>${a.yes}일</td><td>${a.no}일</td><td>${a.difference===null?'자료 부족':(a.difference>0?'+':'')+a.difference+'점 (관련성 탐색)'}</td></tr>`).join('')+'</table></div><p class="muted">평소와 비교 가능한 출력이 하루 3개 이상인 날만 사용합니다. 각 집단 3일 이상부터 계산하며, 소수 표본으로 확정하지 않습니다.</p>';
 const scored=C.evaluate(state),mean=k=>avg(scored.filter(r=>r[k]!==null).map(r=>r[k]));
 $('verifyMetrics').innerHTML=metric('비교 가능한 예측',scored.length+'건')+metric('현재 모델 평균 절대오차',mean('error')??'—')+metric('평소 패턴만의 오차',mean('baseError')??'—');
 $('verifyTable').innerHTML=`<p class="muted">현재 출력을 그대로 유지한다고 가정한 비교 오차: ${mean('holdError')??'—'}점. 미래 출력이 없으면 평가를 보류합니다. 작은 차이로 개선을 확정하지 마세요.</p>`+(scored.length?'<table><tr><th>날짜·목표 시각</th><th>예측</th><th>실제</th><th>오차</th></tr>'+scored.slice(-50).reverse().map(r=>`<tr><td>${r.day} ${C.clock(r.targetMinute)}</td><td>${r.value}</td><td>${r.actual} (${C.clock(r.actualMinute)})</td><td>${r.error}</td></tr>`).join('')+'</table>':'<p class="empty">예측 저장 후, 목표 시각 근처에 출력을 기록해 주세요.</p>');
}
const metric=(title,value)=>`<div class="metric"><small>${title}</small><strong>${value}</strong></div>`;
function renderPrediction(){const fs=state.forecasts.filter(f=>f.day===selected());const latest=fs.at(-1)?.createdAt;const last=fs.filter(f=>f.createdAt===latest);$('forecastCards').innerHTML=last.length?last.map(f=>`<div class="card forecast" style="padding:12px"><strong>${C.clock(f.targetMinute)} · 예상 ${f.value}</strong><br><small>${esc(f.method)} / ${C.clock(f.issuedMinute)}에 저장</small></div>`).join(''):'<p class="empty">저장된 예측이 없습니다.</p>';$('predict').disabled=selected()!==C.day();}
function editors(){
 $('scheduleEditor').innerHTML='<table><tr><th>약물</th><th>시각</th><th>mg</th></tr>'+state.schedule.map((m,i)=>`<tr><td>${esc(m.name)}</td><td><input type="time" id="st${i}" value="${m.time}" aria-label="${esc(m.name)} 시각"></td><td><input type="number" step="any" min=".001" max="2000" id="sd${i}" value="${m.dose}" aria-label="${esc(m.name)} 용량"></td></tr>`).join('')+'</table>';
 $('baselineEditor').innerHTML='<table><tr><th>시각</th><th>출력 (빈칸: 미확인)</th></tr>'+state.baseline.map((b,i)=>`<tr><td>${C.clock(b.t)}</td><td><input type="number" min="0" max="100" id="bv${i}" value="${b.v??''}" aria-label="${C.clock(b.t)} 평소 출력"></td></tr>`).join('')+'</table>';
}
function render(){plot();renderMeds();renderEvents();metrics();renderPrediction();}
function openEditor(type,e=null,slot=null,factor=null){
 editing={type,event:e,slot};$('editTitle').textContent=e?'기록 수정':type==='med'?'실제 복약 기록':type==='factor'?'함께 있었던 일':'출력 수정';
 $('eventTime').value=e?C.clock(e.minute):C.clock(C.minute(new Date()));
 $('medFields').hidden=type!=='med';$('factorFields').hidden=type!=='factor';$('outputFields').hidden=type!=='output';
 $('medDose').required=type==='med';$('editValue').required=type==='output';
 $('medName').value=e?.name||slot?.name||names[0];$('medDose').value=e?.dose??slot?.dose??100;
 $('editValue').value=e?.value??30;$('factorName').value=e?.factor||factor||C.factors[0];$('severity').value=e?.severity||'';$('eventNote').value=e?.note||'';$('formError').textContent='';$('editor').showModal();
}
$('eventForm').onsubmit=e=>{
 e.preventDefault();const m=C.toMinute($('eventTime').value);if(!Number.isFinite(m)||!validTime(selected(),m)){ $('formError').textContent='실제로 지난 날짜·시각만 기록할 수 있습니다.';return;}
 let rec=editing.event?{...editing.event}:baseEvent(editing.type,$('eventTime').value);rec.minute=m;rec.note=$('eventNote').value;rec.updatedAt=new Date().toISOString();
 if(rec.type==='med'){rec.name=$('medName').value;rec.dose=+$('medDose').value;rec.slot=editing.event?.slot||editing.slot?.id||'';}
 if(rec.type==='factor'){rec.factor=$('factorName').value;rec.severity=$('severity').value;}
 if(rec.type==='output')rec.value=+$('editValue').value;
 if(commitEvent(rec)){$('editor').close();render();toast('실제 기록을 저장했습니다.');}
};
$('cancelEdit').onclick=()=>$('editor').close();
$('nowTime').onclick=()=>{$('day').value=C.day();$('outTime').value=C.clock(C.minute(new Date()));render();};
$('saveOutput').onclick=()=>{
 const m=C.toMinute($('outTime').value);if(!Number.isFinite(m)||!validTime(selected(),m)){toast('실제로 지난 날짜·시각만 입력하세요.');return;}
 const e={...baseEvent('output',$('outTime').value),value:+$('slider').value,note:$('outNote').value};
 if(commitEvent(e)){$('outNote').value='';render();toast('출력을 기록했습니다.');}
};
$('slider').oninput=()=>$('value').textContent=$('slider').value;
function adjust(n){$('slider').value=Math.max(0,Math.min(100,+$('slider').value+n));$('slider').oninput();}
$('plus').onclick=()=>adjust(10);$('minus').onclick=()=>adjust(-10);
$('meds').onclick=e=>{const b=e.target.closest('[data-slot]');if(b)openEditor('med',null,state.schedule.find(m=>m.id===b.dataset.slot));};
$('extraMed').onclick=()=>openEditor('med');
$('events').onclick=e=>{const b=e.target.closest('[data-edit],[data-delete]');if(!b)return;const id=b.dataset.edit||b.dataset.delete,rec=state.events.find(x=>x.id===id);if(!rec)return;if(b.dataset.edit)openEditor(rec.type,rec);else{const next=structuredClone(state);next.events=next.events.filter(x=>x.id!==id);if(save(next)){lastDeleted=rec;$('undo').classList.remove('hidden');render();toast('삭제했습니다. 방금 삭제 취소로 복구할 수 있습니다.');}}};
$('undo').onclick=()=>{if(lastDeleted&&commitEvent(lastDeleted)){lastDeleted=null;$('undo').classList.add('hidden');render();}};
$('factorButtons').innerHTML=C.factors.map(f=>`<button data-factor="${f}">${f}</button>`).join('');$('factorButtons').onclick=e=>{const f=e.target.dataset.factor;if(f)openEditor('factor',null,null,f);};
$('predict').onclick=()=>{
 if(selected()!==C.day()){toast('예측은 오늘 현재 시점에서만 저장합니다.');return;}
 const now=new Date();if(state.forecasts.some(f=>f.day===C.day(now)&&f.issuedMinute===C.minute(now))){toast('이 시각의 예측이 이미 저장되어 있습니다.');return;}
 const fs=C.forecast(state,now);if(!fs.length){toast('앞으로의 표준 출력이 미확인 구간이어서 예측을 보류합니다.');return;}
 const next=structuredClone(state);next.forecasts.push(...fs);if(save(next)){render();toast(`${fs.length}개 예측을 보존했습니다. 실제 출력과 비교해 보세요.`);}
};
$('saveSchedule').onclick=()=>{const next=structuredClone(state);next.schedule.forEach((m,i)=>{m.time=$('st'+i).value;m.dose=+$('sd'+i).value;});if(save(next)){render();toast('표준표 저장. 실제 복약 기록은 그대로입니다.');}};
$('saveBaseline').onclick=()=>{const next=structuredClone(state);next.baseline.forEach((b,i)=>b.v=$('bv'+i).value===''?null:+$('bv'+i).value);if(save(next)){render();toast('표준 출력 도식을 저장했습니다.');}};
function download(name,content,type){const url=URL.createObjectURL(new Blob([content],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function backup(){download('P1-backup-'+C.day()+'.json',JSON.stringify(state,null,2),'application/json');}
$('export').onclick=backup;
$('csv').onclick=()=>{const quote=v=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replace(/"/g,'""')+'"';const rows=[['날짜','시각','종류','출력','약명','용량mg','요인','정도','메모'],...state.events.map(e=>[e.day,C.clock(e.minute),e.type,e.value,e.name,e.dose,e.factor,e.severity,e.note])];download('P1-events-'+C.day()+'.csv','\ufeff'+rows.map(r=>r.map(quote).join(',')).join('\r\n'),'text/csv;charset=utf-8');};
$('importFile').onchange=async e=>{const f=e.target.files[0];if(!f)return;try{if(f.size>20*1024*1024)throw Error('파일은 20MB 이하여야 합니다.');const incoming=C.validate(JSON.parse(await f.text()));if(incoming.schedule.some(m=>!names.includes(m.name)))throw Error('지원하지 않는 약물 이름입니다.');if(!confirm(`백업의 실제 기록 ${incoming.events.length}개로 현재 자료 전체를 복원할까요? 현재 자료도 먼저 다운로드합니다.`))return;if(!blocked)backup();const was=blocked;blocked=false;if(save(incoming)){$('storageWarning').classList.add('hidden');editors();render();toast('백업을 복원했습니다.');}else blocked=was;}catch(err){toast(err.message||'백업을 읽지 못했습니다.');}finally{e.target.value='';}};
$('print').onclick=()=>window.print();
$('curveMode').onchange=plot;
$('day').value=C.day();$('day').max=C.day();$('outTime').value=C.clock(C.minute(new Date()));
$('today').onclick=()=>{$('day').value=C.day();$('outTime').value=C.clock(C.minute(new Date()));render();};
$('day').onchange=()=>{if(!$('day').value||$('day').value>C.day()){$('day').value=C.day();}render();};
$('medName').innerHTML=names.map(n=>`<option>${n}</option>`).join('');$('factorName').innerHTML=C.factors.map(n=>`<option>${n}</option>`).join('');
$('medName').onchange=()=>{$('medDose').value='';};
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-tab]').forEach(x=>x.classList.toggle('active',x===b));document.querySelectorAll('.tabpage').forEach(p=>p.classList.toggle('hidden',p.id!==b.dataset.tab));if(b.dataset.tab==='settings')editors();else render();});
window.addEventListener('storage',e=>{if(e.key===KEY){blocked=true;$('storageWarning').classList.remove('hidden');$('storageWarning').textContent='다른 탭에서 기록이 바뀌었습니다. 이 탭의 덮어쓰기를 막았습니다. 새로고침해 최신 기록을 불러오세요.';}});
$('storageStatus').textContent='기기 내 저장 · 외부 전송 없음';editors();render();
