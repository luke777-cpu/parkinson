// v1.0 preview: local reports, backups, explicit reminders and draft recovery.
let platform={settings:{},backups:{files:[]}},reportMonth=chosen.slice(0,7),draftKey=null,draftTimer=null,dialogGeneration=0;
const baseRender=render,baseBind=bind,baseRefresh=refresh,baseDialog=openDialog;
const eventDay=e=>dateKey(new Date(e.occurred_at));
const statusLabel=p=>p.status==='taken'?'복용 완료':p.status==='not_taken'?'미복용':p.completed?'기존 복용 완료':'기존 미완료';
function details(e){const p=e.payload;if(e.kind==='medication')return `${p.name} · ${statusLabel(p)}${p.actual_at?' · 실제 '+local(p.actual_at).replace('T',' '):' · 실제 복용 시각 없음'}${p.dose?' · '+p.dose:''}${p.note?' · '+p.note:''}`;if(e.kind==='output')return `Output ${p.value} · ${p.note}`;if(e.kind==='motor_state')return `${p.state} (직접 기록) · ${p.note}`;if(e.kind==='exercise')return `${p.name} · ${p.minutes}분 · ${p.note}`;if(e.kind==='note')return p.text;return `${labels[e.kind]} · ${p.severity} · ${p.note}`}
refresh=async function(){
 [platform.settings,platform.backups]=await Promise.all([api('settings'),api('backups')]);
 document.documentElement.classList.toggle('large',platform.settings.large_text);await baseRefresh();
};
function outputChart(events){
 const dots=events.filter(e=>e.kind==='output').sort((a,b)=>new Date(a.occurred_at)-new Date(b.occurred_at));
 let svg='<svg class="output-chart" viewBox="0 0 1000 270" role="img" aria-label="직접 기록한 약효 Output 점 그래프. 점 사이를 추정하지 않습니다.">';
 for(const v of [0,25,50,75,100]){const y=220-v*1.8;svg+=`<line x1="48" x2="975" y1="${y}" y2="${y}" stroke="#e3e9e4"/><text x="10" y="${y+5}">${v}</text>`}
 for(const h of [0,6,12,18,24])svg+=`<text x="${48+h/24*927-12}" y="250">${String(h).padStart(2,'0')}:00</text>`;
 for(const e of dots){const t=new Date(e.occurred_at),x=48+(t.getHours()*60+t.getMinutes())/1440*927,y=220-e.payload.value*1.8;svg+=`<circle data-output-point="${e.id}" cx="${x}" cy="${y}" r="6" fill="#237653"><title>${esc(local(e.occurred_at))} · Output ${e.payload.value}</title></circle>`}
 return svg+'</svg>'+(!dots.length?'<p class="empty">이 날짜에 Output 기록이 없습니다.</p>':'')+'<p class="hint">직접 입력한 값만 점으로 표시합니다. 점 사이의 값과 ON/OFF는 추정하지 않습니다.</p>';
}
function timelinePage(){
 const entries=state.events.filter(e=>!e.deleted&&eventDay(e)===chosen&&['medication','exercise','output','motor_state','dyskinesia','dystonia','freezing'].includes(e.kind));
 let html=title('DAILY RHYTHM','하루 시간표','복약 예정과 실제 복용, 운동, 약효와 증상을 시간순으로 확인합니다.')+dateToolbar()+`<div class="toolbar"><button id="timelineMeds">복약 기록</button><button id="timelineSymptoms">약효 · 증상 기록</button><button id="timelineExercise">운동 기록</button></div><section class="card"><h2>약효 Output · 0~100</h2>${outputChart(entries)}</section>`;
 let rows=daily.plans.map(p=>({time:p.scheduled_at,title:'복약 예정',body:`${p.slot} · ${p.name} · ${p.planned_dose}`,id:null,plan:p}));
 for(const e of entries){if(e.kind==='medication'&&!e.payload.actual_at&&e.payload.scheduled_at.slice(0,10)!==chosen)continue;rows.push({time:e.payload.actual_at||e.occurred_at,title:e.kind==='medication'?(e.payload.status==='not_taken'?'미복용 · 예정시각 기준':'실제 복용 기록'):labels[e.kind],body:details(e),id:e.id})}
 rows.sort((a,b)=>new Date(a.time)-new Date(b.time));
 html+='<div class="timeline">'+rows.map(r=>`<div class="timeline-row"><time>${esc(local(r.time).slice(11))}</time><div><span class="badge">${esc(r.title)}</span><p>${esc(r.body)}</p></div>${r.id?`<button data-history="${r.id}">이력</button>`:''}</div>`).join('')+'</div>';
 const note=active('note').find(e=>e.payload.date===chosen);return html+`<section class="card"><h2>하루 메모</h2><p class="note">${esc(note?.payload.text||'기록 없음')}</p><button data-note-date="${chosen}">메모 작성 · 수정</button></section>`;
}
function reportsPage(){
 const events=state.events.filter(e=>!e.deleted&&['medication','exercise','output','motor_state','dyskinesia','dystonia','freezing','note'].includes(e.kind)&&(e.kind==='note'?e.payload.date:eventDay(e)).startsWith(reportMonth));
 const meds=events.filter(e=>e.kind==='medication'),taken=meds.filter(e=>e.payload.status==='taken'||e.payload.completed),missed=meds.filter(e=>e.payload.status==='not_taken'),exercise=events.filter(e=>e.kind==='exercise'),outputs=events.filter(e=>e.kind==='output');
 let html=title('MONTHLY RECORD','월간 기록 보고서','입력한 기록을 요약합니다. 의학적 해석이나 복용량 권고는 포함하지 않습니다.')+`<div class="toolbar no-print"><label for="reportMonth">보고서 월</label><input id="reportMonth" type="month" value="${reportMonth}" style="width:auto"><button id="printReport" class="primary">인쇄 · PDF 저장</button></div><h2>${esc(reportMonth)} 기록</h2><div class="summary"><span>복용 완료 ${taken.length}건</span><span>명시적 미복용 ${missed.length}건</span><span>운동 ${exercise.length}건 · ${exercise.reduce((s,e)=>s+e.payload.minutes,0)}분</span><span>Output ${outputs.length}회 기록</span></div><p class="hint">기록이 없는 날은 복용/미복용을 판단하지 않습니다. 실제 복용 기록은 실제 시각의 날짜에 포함합니다. 기존 미완료는 별도 기록 그대로 남습니다.</p><table class="report-table"><thead><tr><th>날짜 · 시각</th><th>구분</th><th>기록 내용</th></tr></thead><tbody>`;
 events.sort((a,b)=>new Date(a.occurred_at)-new Date(b.occurred_at));
 html+=events.map(e=>`<tr><td>${esc(e.kind==='note'?e.payload.date:local(e.occurred_at).replace('T',' '))}</td><td>${esc(labels[e.kind])}</td><td>${esc(details(e))}</td></tr>`).join('')+'</tbody></table>';
 return html+(events.length?'':'<p class="empty">이 달에 입력한 기록이 없습니다.</p>');
}
function settingsPage(){return title('PREFERENCES','설정 · 알림','알림 확인과 실제 복용 기록은 따로 관리합니다.')+`<section class="card"><label><input id="largeText" type="checkbox" ${platform.settings.large_text?'checked':''}> 큰 글씨</label><label><input id="remindersEnabled" type="checkbox" ${platform.settings.reminders?'checked':''}> 앱 실행 중 복약 알림</label><p class="hint">앱이 열려 있을 때, 예정시간부터 설정한 확인 범위 안의 기록 전 항목을 알립니다. 앱 종료·PC 절전 중에는 알림이 제공되지 않습니다. 확인을 눌러도 복용 완료가 되지 않습니다.</p>${field('지난 예정시간 알림 확인 범위 (분, 1~120)','reminderWindow',platform.settings.reminder_window_minutes,'number')}<button id="notificationPermission">Windows 알림 권한 요청</button><span id="notificationState" class="hint"> ${typeof Notification==='undefined'?'화면 내 알림 사용':Notification.permission}</span></section><section class="card" style="margin-top:24px"><h2>백업</h2><label><input id="autoBackup" type="checkbox" ${platform.settings.auto_backup?'checked':''}> 저장할 때 최신 자동 백업 + 일별 백업</label>${field('백업 폴더 전체 경로 (비우면 기본 폴더)','backupDirectory',platform.settings.backup_directory)}<p class="hint">기본: 앱 데이터 폴더의 backups. 다른 드라이브나 외장장치의 폴더도 지정할 수 있습니다. 최신 자동 백업은 저장할 때 갱신하고, 일별 자동 백업은 최근 30개를 보관합니다. 수동·복원 전 백업은 자동 삭제하지 않습니다.</p></section><button id="saveSettings" class="primary" style="margin-top:24px">설정 저장</button>`}
function backupSection(){return `<section class="card" style="margin-top:24px"><h2>백업 · 안전 복원</h2><p class="hint">${esc(platform.backups.directory)}<br>${esc(platform.backups.error||'백업은 SQLite 원본과 교환 JSON, 무결성 확인 정보를 함께 보관합니다.')}</p><div class="row"><button id="makeBackup" class="primary">지금 백업</button><button id="uploadRestore">다른 폴더의 백업 검사</button><input id="backupFile" type="file" accept=".plmbackup" hidden></div><p class="hint">복원 전 내용을 검사합니다. 현재 기록을 삭제하지 않고 이력을 합치며, 양쪽 수정은 충돌로 보관합니다. 복원 직전 현재 DB도 자동 백업합니다.</p>${platform.backups.files.slice(0,50).map(f=>`<div class="entry row"><span>${esc(f.name)} · ${(f.bytes/1024).toFixed(1)} KB</span><span class="spacer"></span><button data-backup-download="${esc(f.name)}">파일 저장</button><button data-backup-preview="${esc(f.name)}">복원 검사</button></div>`).join('')||'<p class="empty">아직 백업이 없습니다.</p>'}</section><section class="card" style="margin-top:24px"><h2>외부 앱 교환 준비</h2><p>plm-1.1 JSON 파일 교환 및 병합 이력 전달을 지원합니다. 기존 약효일지의 DB/API 어댑터는 아직 연결되지 않았습니다.</p><p class="hint">받은 JSON을 가져온 뒤 결과를 확인하고, 현재 JSON을 내보내 상대 앱으로 가져옵니다. 같은 파일을 반복 교환해도 같은 revision을 추가하지 않습니다.</p></section>`}
render=function(){
 if(view==='timeline'||view==='reports'||view==='settings'){
  $('#app').innerHTML=view==='timeline'?timelinePage():view==='reports'?reportsPage():settingsPage();baseBind();extraBind();
 }else{baseRender();if(view==='data'){$('#app').insertAdjacentHTML('beforeend',backupSection());document.querySelectorAll('[data-history]').forEach(b=>{const e=find(b.dataset.history);if(e?.deleted)b.insertAdjacentHTML('afterend',`<button data-recover="${e.id}">삭제 기록 복구</button>`)});extraBind()}}
 document.body.dataset.view=view;
};
async function previewBackup(body){try{const p=await api('restore-preview',body);openDialog(`<h2>복원 미리보기</h2><p>백업 시각: ${esc(p.created_at)}</p><div class="summary">새 이력 ${p.preview.added}건 · 중복 ${p.preview.duplicates}건 · 새 충돌 ${p.preview.conflicts}건</div><p>${esc(p.policy)}</p><p class="hint">복원 직전 현재 데이터의 안전 백업을 먼저 생성합니다.</p>`,async()=>{const result=await api('restore',{ticket:p.ticket});toast('안전 백업: '+result.safety_backup)},'이력을 합쳐 복원')}catch(e){toast(e.message)}}
function extraBind(){
 if($('#timelineMeds')){$('#timelineMeds').onclick=()=>{view='medication';render()};$('#timelineSymptoms').onclick=()=>{view='symptoms';render()};$('#timelineExercise').onclick=()=>{view='exercise';render()}}
 if($('#reportMonth')){$('#reportMonth').onchange=e=>{if(e.target.value){reportMonth=e.target.value;render()}};$('#printReport').onclick=()=>window.print()}
 if($('#saveSettings')){
  $('#backupDirectory').required=false;$('#reminderWindow').min=1;$('#reminderWindow').max=120;
  $('#saveSettings').onclick=async()=>{try{await api('settings',{large_text:$('#largeText').checked,reminders:$('#remindersEnabled').checked,auto_backup:$('#autoBackup').checked,backup_directory:$('#backupDirectory').value.trim(),reminder_window_minutes:Number($('#reminderWindow').value)});await refresh();toast('설정을 저장했습니다.');pollReminders()}catch(e){toast(e.message)}};
  $('#notificationPermission').onclick=async()=>{try{if(typeof Notification!=='undefined')$('#notificationState').textContent=await Notification.requestPermission()}catch(e){toast(e.message)}};
 }
 if($('#makeBackup')){
  $('#makeBackup').onclick=async()=>{try{await api('backup',{});await refresh();toast('백업 파일을 생성했습니다.')}catch(e){toast(e.message)}};
  $('#uploadRestore').onclick=()=>$('#backupFile').click();$('#backupFile').onchange=async e=>{const f=e.target.files[0];if(!f)return;try{if(f.size>20*1024*1024)throw Error('20MB 이하의 백업을 선택하세요.');const bytes=new Uint8Array(await f.arrayBuffer());let raw='';for(let i=0;i<bytes.length;i+=8192)raw+=String.fromCharCode(...bytes.subarray(i,i+8192));await previewBackup({file_base64:btoa(raw)})}catch(x){toast(x.message)}};
 }
 document.querySelectorAll('[data-backup-preview]').forEach(b=>b.onclick=()=>previewBackup({name:b.dataset.backupPreview}));
 document.querySelectorAll('[data-backup-download]').forEach(b=>b.onclick=async()=>{try{const r=await fetch('/api/backup-download',{method:'POST',headers:{'Content-Type':'application/json','X-PLM-Token':token},body:JSON.stringify({name:b.dataset.backupDownload})});if(!r.ok)throw Error((await r.json()).error);const u=URL.createObjectURL(await r.blob()),a=document.createElement('a');a.href=u;a.download=b.dataset.backupDownload;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)}catch(e){toast(e.message)}});
 document.querySelectorAll('[data-recover]').forEach(b=>b.onclick=()=>openDialog('<h2>삭제 기록 복구</h2><p>기존 이력을 보존하고 현재 기록으로 복구합니다.</p>',()=>api('recover',{id:b.dataset.recover}),'새 버전으로 복구'));
}
// Drafts live separately in SQLite. They never become medication records automatically.
function captureDraft(){const values=[];if($('#meds')){const rows=[...document.querySelectorAll('.medrow')];values.push({selector:'__medrow_count',value:String(rows.length)});rows.forEach((row,i)=>values.push({selector:'__medicine_id:'+i,value:row.dataset.mid}))}document.querySelectorAll('#dialogBody input,#dialogBody select,#dialogBody textarea').forEach(el=>{if(el.type==='button'||el.type==='file')return;let selector=el.id?'#'+el.id:null;if(!selector&&el.dataset.k){const row=el.closest('.medrow'),i=[...document.querySelectorAll('.medrow')].indexOf(row);selector=`.medrow:nth-child(${i+1}) [data-k="${el.dataset.k}"]`}if(selector)values.push({selector,value:el.value})});return values}
openDialog=function(html,save,label){
 clearTimeout(draftTimer);draftKey=null;let key=null;const generation=++dialogGeneration;
 baseDialog(html,save?async()=>{clearTimeout(draftTimer);const result=await save();if(key)await api('draft',{key,delete:true}).catch(()=>{});draftKey=null;return result}:null,label);
 if(!save||!$('#dialogBody').querySelector('input,select,textarea'))return;
 const body=$('#dialogBody');
 crypto.subtle.digest('SHA-256',new TextEncoder().encode(chosen+'|'+html)).then(async hash=>{
  key=[...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('');if(!$('#modal').open||dialogGeneration!==generation)return;draftKey=key;
  const draft=await api('draft',{key});if(draft.entries&&$('#modal').open&&draftKey===key){const box=document.createElement('div');box.className='previous';box.innerHTML='<b>저장하지 않은 작성 내용이 있습니다.</b><p class="hint">임시 작성은 실제 기록이 아닙니다. 내용을 복구한 뒤 확인하고 저장하세요.</p><button type="button" id="restoreDraft">임시 작성 복구</button> <button type="button" id="discardDraft">임시 작성 삭제</button>';body.prepend(box);$('#restoreDraft').onclick=()=>{const countEntry=draft.entries.find(x=>x.selector==='__medrow_count');const count=countEntry?Math.min(50,Math.max(0,Number(countEntry.value))):null;if(count!==null&&$('#meds')){while(document.querySelectorAll('.medrow').length<count)$('#addmed').click();while(document.querySelectorAll('.medrow').length>count)document.querySelector('.medrow:last-child').remove()}for(const entry of draft.entries){if(entry.selector.startsWith('__medicine_id:')){const row=document.querySelectorAll('.medrow')[Number(entry.selector.split(':')[1])];if(row)row.dataset.mid=entry.value;continue}if(entry.selector.startsWith('__'))continue;const el=body.querySelector(entry.selector);if(el){el.value=entry.value;el.dispatchEvent(new Event('change',{bubbles:true}))}}box.remove()};$('#discardDraft').onclick=async()=>{await api('draft',{key,delete:true});box.remove()}}
 }).catch(e=>toast('임시 작성 확인 실패: '+e.message));
 body.oninput=()=>{clearTimeout(draftTimer);draftTimer=setTimeout(async()=>{try{if(draftKey===key&&key&&$('#modal').open)await api('draft',{key,entries:captureDraft()})}catch(e){toast('임시 작성 저장 실패: '+e.message)}},500)};
};
$('#modal').addEventListener('close',()=>{clearTimeout(draftTimer);draftKey=null});
const notified=new Set();let reminderBusy=false;
async function pollReminders(){
 if(closing||reminderBusy)return;reminderBusy=true;
 try{const due=await api('reminders');let panel=$('#reminderPanel');if(!panel){panel=document.createElement('div');panel.id='reminderPanel';panel.className='reminder-panel';document.body.append(panel)}
  panel.innerHTML=due.length?`<b>복약 예정 알림</b><p class="hint">확인은 복용 완료 기록이 아닙니다.</p>`+due.map(p=>`<div class="entry"><p>${esc(p.slot)} · ${esc(p.name)} · 예정 ${esc(p.scheduled_at.slice(11,16))}</p><button data-reminder-ack="${p.plan_id}">알림 확인</button> <button data-reminder-open="${p.plan_id}">복용 기록 열기</button></div>`).join(''):'';panel.hidden=!due.length;
  due.forEach(p=>{if(!notified.has(p.plan_id)){notified.add(p.plan_id);if(typeof Notification!=='undefined'&&Notification.permission==='granted')try{new Notification('복약 예정 확인',{body:p.slot+' · '+p.name+' · 실제 복용은 직접 기록하세요.'})}catch{}}});
  panel.querySelectorAll('[data-reminder-ack]').forEach(b=>b.onclick=async()=>{const p=due.find(x=>x.plan_id===b.dataset.reminderAck);await api('reminder-ack',p);pollReminders()});
  panel.querySelectorAll('[data-reminder-open]').forEach(b=>b.onclick=async()=>{const p=due.find(x=>x.plan_id===b.dataset.reminderOpen);chosen=p.scheduled_at.slice(0,10);view='medication';await refresh();editPlan(daily.plans.find(x=>x.plan_id===p.plan_id))});
 }catch{}finally{reminderBusy=false}
}
setInterval(()=>pollReminders(),15000);setTimeout(()=>pollReminders(),1000);
window.addEventListener('error',()=>{if(!closing)toast('화면 오류가 발생했습니다. 임시 작성을 복구하거나 다시 열어 주세요.')});
