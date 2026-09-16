(async()=>{
const assert=require('node:assert/strict'),fs=require('fs');
const C=require('./core.js');let passed=0;
async function test(n,f){await f();passed++;console.log('PASS '+n);}
const now=new Date(2026,8,14,8,0),day=C.day(now);
const event=(minute,value,created=now.toISOString())=>({id:C.id(),day,minute,type:'output',value,createdAt:created,note:''});
await test('표준표는 실제 기록을 생성하지 않는다',()=>{const s=C.defaults();assert.equal(s.schedule.length,9);assert.equal(s.events.length,0);assert.equal(s.forecasts.length,0);});
await test('미확인 출력 구간은 0으로 채우지 않는다',()=>{const s=C.defaults();assert.equal(C.base(s.baseline,1060),null);assert.equal(C.base(s.baseline,360),25);});
await test('예측에는 미래 출력이 유입되지 않는다',()=>{const s=C.defaults();s.events.push(event(475,40));const a=C.forecast(s,now).map(f=>f.value);s.events.push(event(540,100));assert.deepEqual(C.forecast(s,now).map(f=>f.value),a);});
await test('현재 최근 출력 보정과 비교 기준을 함께 저장한다',()=>{const s=C.defaults();s.events.push(event(475,40));const f=C.forecast(s,now);assert.equal(f.length,3);assert.equal(f[0].lastValue,40);assert.ok(f[0].value<f[0].baseline);assert.ok(f.every(x=>x.value>=0&&x.value<=100));});
await test('오래된 출력은 보정에 사용하지 않는다',()=>{const s=C.defaults();s.events.push(event(360,0));assert.equal(C.forecast(s,new Date(2026,8,14,10,30))[0].lastValue,null);});
await test('과거 자료를 미래 결과처럼 평가하지 않는다',()=>{const s=C.defaults();s.forecasts=C.forecast(s,now);s.events.push(event(510,80,new Date(now.getTime()-60000).toISOString()));assert.equal(C.evaluate(s).length,0);});
await test('목표 15분 이내 사후 출력만 비교한다',()=>{const s=C.defaults();s.forecasts=C.forecast(s,now);s.events.push(event(512,80,new Date(now.getTime()+32*60000).toISOString()));const e=C.evaluate(s);assert.equal(e.length,1);assert.equal(e[0].actual,80);assert.equal(e[0].error,Math.abs(e[0].value-80));});
await test('사후 표준 변경은 저장된 예측을 바꾸지 않는다',()=>{const s=C.defaults();s.forecasts=C.forecast(s,now);const frozen=JSON.stringify(s.forecasts);s.baseline.forEach(p=>{if(p.v!==null)p.v=10;});assert.equal(JSON.stringify(s.forecasts),frozen);});
await test('손상 백업과 범위 초과 값을 거절한다',()=>{const s=C.defaults();s.events.push(event(480,101));assert.throws(()=>C.validate(s));const x=C.defaults();x.schedule[0].time='25:00';assert.throws(()=>C.validate(x));});
await test('부족한 관찰은 요인 관련성을 계산하지 않는다',()=>{assert.ok(C.associations(C.defaults()).every(a=>a.difference===null));});
const {JSDOM}=require('jsdom');const html=fs.readFileSync(__dirname+'/P1-Lab.html','utf8');let errors=[];
const {VirtualConsole}=require('jsdom');const vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e));
const dom=new JSDOM(html,{runScripts:'dangerously',url:'http://localhost:8879',virtualConsole:vc,beforeParse(w){w.structuredClone=structuredClone;w.navigator.locks={request:async(name,fn)=>fn()};w.HTMLDialogElement.prototype.showModal=function(){this.open=true};w.HTMLDialogElement.prototype.close=function(){this.open=false};w.confirm=()=>true;}});
const w=dom.window,$=id=>w.document.getElementById(id),click=id=>$(id).click();
await test('앱 시작·그래프 렌더와 빈 실제 기록',()=>{assert.equal(errors.length,0);assert.ok($('chart').querySelector('svg'));assert.equal(w.localStorage.getItem('p1-lab-v1'),null);});
// Select yesterday to ensure synthetic test entries never fall in the future.
const yesterday=new Date();yesterday.setDate(yesterday.getDate()-1);$('day').value=C.day(yesterday);$('day').dispatchEvent(new w.Event('change'));
await test('출력 저장·수정·삭제 취소',()=>{
 $('outTime').value='08:00';$('slider').value='70';$('outNote').value='<img src=x onerror=alert(1)>';click('saveOutput');
 let s=JSON.parse(w.localStorage.getItem('p1-lab-v1'));assert.equal(s.events[0].value,70);assert.equal($('events').querySelector('img'),null);
 $('events').querySelector('[data-edit]').click();$('editValue').value='80';$('eventForm').dispatchEvent(new w.Event('submit',{cancelable:true}));s=JSON.parse(w.localStorage.getItem('p1-lab-v1'));assert.equal(s.events[0].value,80);
 $('events').querySelector('[data-delete]').click();assert.equal(JSON.parse(w.localStorage.getItem('p1-lab-v1')).events.length,0);click('undo');assert.equal(JSON.parse(w.localStorage.getItem('p1-lab-v1')).events.length,1);
});
await test('복약 묶음은 개별 시각을 저장하고 재확인해도 중복되지 않는다',async()=>{
 $('meds').querySelector('[data-group="06:00"]').click();
 const rows=$('groupRows').querySelectorAll('[data-med-row]');rows[0].querySelector('[data-time]').value='06:10';rows[1].querySelector('[data-time]').value='06:12';
 $('groupForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await new Promise(r=>setTimeout(r,0));
 let s=JSON.parse(w.localStorage.getItem('p1-lab-v1'));assert.equal(s.events.filter(e=>e.type==='med').length,3);assert.equal(s.events.find(e=>e.slot==='cr1').minute,370);assert.equal(s.events.find(e=>e.slot==='prami').minute,372);
 $('meds').querySelector('[data-group="06:00"]').click();$('groupForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await new Promise(r=>setTimeout(r,0));assert.equal(JSON.parse(w.localStorage.getItem('p1-lab-v1')).events.filter(e=>e.type==='med').length,3);
});
await test('복약 수정은 ID와 최초 확인 시각을 유지하고 이력을 보존한다',async()=>{
 const before=JSON.parse(w.localStorage.getItem('p1-lab-v1')).events.find(e=>e.slot==='cr1');
 $('meds').querySelector('[data-group="06:00"]').click();$('groupRows').querySelector('[data-time]').value='06:15';$('groupForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await new Promise(r=>setTimeout(r,0));
 const s=JSON.parse(w.localStorage.getItem('p1-lab-v1'));const after=s.events.find(e=>e.id===before.id);assert.equal(after.minute,375);assert.equal(after.createdAt,before.createdAt);assert.deepEqual(s.medicationHistory[0].before,before);assert.equal(s.events.filter(e=>e.type==='med').length,3);
});
await test('실제 복약 곡선 전환과 요인 기록',()=>{
 $('curveMode').value='actual';$('curveMode').dispatchEvent(new w.Event('change'));assert.ok($('curveNote').textContent.includes('확인된 약만'));
 $('factorButtons').querySelector('[data-factor="이상운동증"]').click();$('eventTime').value='11:00';$('eventForm').dispatchEvent(new w.Event('submit',{cancelable:true}));assert.equal(JSON.parse(w.localStorage.getItem('p1-lab-v1')).events.filter(e=>e.type==='factor').length,1);
});
await test('저장 데이터는 다시 불러올 수 있다',()=>{assert.doesNotThrow(()=>C.validate(JSON.parse(w.localStorage.getItem('p1-lab-v1'))));});
await test('복수 탭의 덮어쓰기를 방지한다',()=>{const before=w.localStorage.getItem('p1-lab-v1');w.dispatchEvent(new w.StorageEvent('storage',{key:'p1-lab-v1'}));click('saveOutput');assert.equal(w.localStorage.getItem('p1-lab-v1'),before);});
assert.equal(errors.length,0);dom.window.close();console.log(`${passed} checks passed`);

})().catch(e=>{console.error(e);process.exitCode=1;});
