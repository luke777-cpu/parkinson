// Served locally; original diary is retained with a SQLite snapshot journal.
const diaryBoot=window.__DIARY_BOOT__;
let diaryRevision=diaryBoot.revision,diaryQueue=Promise.resolve(),diaryPending=0,diaryError=false;
window.diarySaveState=()=>({pending:diaryPending,error:diaryError});
const banner=document.createElement('div');banner.style.cssText='position:sticky;top:0;z-index:99999;background:#f0f8f4;color:#174f3b;padding:12px;border-bottom:1px solid #cbded3;font:14px sans-serif';
banner.innerHTML='<b>기존 약효일지 · 통합 실험</b> <span id="bridgeStatus">SQLite 저장 준비</span> <button id="bridgeSync">Output 양방향 교환</button> <button id="bridgeHistory">원본·변경 이력 내보내기</button><div>숫자로 입력한 Output만 교환합니다. 복약·증상·ON/OFF·삭제는 자동 교환하지 않습니다.</div>';
document.body.prepend(banner);
const status=document.getElementById('bridgeStatus');
async function bridgeCall(path,body){const r=await fetch('/api/diary/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-PLM-Token':diaryBoot.token},body:body?JSON.stringify(body):undefined});const data=await r.json();if(!r.ok)throw Error(data.error||'저장 실패');return data}
function persistDiary(){const documentCopy=JSON.parse(JSON.stringify(db));diaryPending++;status.textContent='저장 중…';diaryQueue=diaryQueue.then(async()=>{if(diaryError)throw Error('앞선 저장 실패. JSON을 내보내고 다시 열어 주세요.');const result=await bridgeCall('save',{document:documentCopy,expected_revision:diaryRevision});diaryRevision=result.revision;status.textContent='SQLite 저장됨';}).catch(e=>{diaryError=true;status.textContent='저장 실패: '+e.message;status.style.color='#a11';}).finally(()=>diaryPending--);return diaryQueue}
const originalDiarySave=save;save=function(){originalDiarySave();persistDiary()};
window.addEventListener('beforeunload',e=>{if(diaryPending||diaryError){e.preventDefault();e.returnValue='저장 상태를 확인하세요.'}});
document.getElementById('bridgeSync').onclick=async function(){this.disabled=true;try{await diaryQueue;if(diaryError)throw Error('저장 오류를 먼저 확인하세요.');const result=await bridgeCall('sync',{expected_revision:diaryRevision});diaryRevision=result.revision;db=result.document;originalDiarySave();renderAll();status.textContent=`교환 완료: 일지→일정 ${result.added+result.updated}건 / 일정→일지 ${result.pulled}건`;parent.postMessage({type:'plm-diary-synced'},location.origin)}catch(e){status.textContent=e.message}finally{this.disabled=false}};
document.getElementById('bridgeHistory').onclick=async()=>{try{await diaryQueue;const history=await bridgeCall('history');const blob=new Blob([JSON.stringify({schema:'plm-diary-journal-1',history,unsaved_document:diaryError?db:null},null,2)],{type:'application/json'});await saveFileSafely(blob,'약효일지_통합실험_변경이력.json',{mimeType:'application/json'})}catch(e){status.textContent=e.message}};
persistDiary();
