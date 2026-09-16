'use strict';
const assert = require('node:assert/strict');
const C = require('./core.js');
require('./medication.js');
const M = globalThis.P1Medication;
const AT = '2026-09-16T22:00:00+09:00', DAY = '2026-09-16';
let passed = 0;
function test(name, fn) { try { fn(); passed++; console.log('PASS ' + name); } catch (e) { console.error('FAIL ' + name); throw e; } }
function event(patch={}) { return {id:'legacy',type:'med',day:DAY,minute:360,createdAt:'2026-09-16T06:10:00+09:00',name:'퍼킨 CR',dose:100,slot:'',note:'',...patch}; }
function state(events=[]) { return {...C.defaults(),events}; }
function confirm(patch={}) { return {mode:'confirm',day:DAY,items:[{id:C.id(),slot:'cr1',time:'06:00',name:'퍼킨 CR',dose:100,note:'',...patch}]}; }
function correct(old, patch={}) { return {mode:'correct',day:old.day,items:[{...old,expected:structuredClone(old),time:C.clock(old.minute),...patch}]}; }
function apply(s, c) { return M.apply(s,c,AT); }

test('legacy exact plan is recognized without mutating data',()=>{const s=state([event()]), before=JSON.stringify(s);assert.equal(M.matches(s,DAY,'cr1').length,1);assert.equal(JSON.stringify(s),before);});
test('slotless legacy plus planned confirm remains one record',()=>{const s=state([event()]);assert.deepEqual(apply(s,confirm()),s);});
test('20 scheduled confirmations with new IDs stay one',()=>{let s=state();for(let i=0;i<20;i++)s=apply(s,confirm());assert.equal(s.events.length,1);});
test('same scheduled occurrence with changed time does not append',()=>{let s=apply(state(),confirm());s=apply(s,confirm({time:'07:18'}));assert.equal(s.events.length,1);assert.equal(s.events[0].minute,360);});
test('legacy correction links old ID to slot and keeps before in audit',()=>{const old=event(), s=apply(state([old]),correct(old,{time:'06:05'}));assert.equal(s.events[0].id,old.id);assert.equal(s.events[0].slot,'cr1');assert.equal(s.medicationHistory[0].before.slot,'');assert.equal(s.events[0].minute,365);assert.equal(apply(s,confirm()).events.length,1);});
test('unchanged legacy correction canonicalizes once',()=>{let s=apply(state([event()]),correct(event()));assert.equal(s.events[0].slot,'cr1');s=apply(s,correct(s.events[0]));assert.equal(s.medicationHistory.length,1);});
test('evening correction keeps ID and one event',()=>{let s=apply(state(),confirm({slot:'cr3',time:'18:00'})), id=s.events[0].id;s=apply(s,correct(s.events[0],{time:'17:15'}));assert.equal(s.events.length,1);assert.equal(s.events[0].id,id);assert.equal(s.events[0].slot,'cr3');assert.equal(s.events[0].minute,1035);});
test('morning noon evening are three distinct doses',()=>{let s=state();for(const [slot,time] of [['cr1','06:00'],['cr2','12:00'],['cr3','18:00']])s=apply(s,confirm({slot,time}));assert.equal(s.events.length,3);});
test('same drug on different days is retained',()=>{let s=apply(state(),confirm()), c=confirm();c.day='2026-09-15';s=apply(s,c);assert.equal(s.events.length,2);});
test('existing legacy duplicates block creation without deleting',()=>{const s=state([event(),event({id:'other'})]), before=JSON.stringify(s);assert.throws(()=>apply(s,confirm()),/여러 기록/);assert.equal(JSON.stringify(s),before);});
test('ambiguous legacy schedule is never guessed',()=>{const s=state([event()]);s.schedule.push({id:'other',name:'퍼킨 CR',dose:100,time:'06:00'});assert.equal(M.slot(s,s.events[0]),'');});
test('nearby but unequal time is not guessed',()=>{const s=state([event({minute:361})]);assert.equal(M.slot(s,s.events[0]),'');});
test('different dose is not inferred as legacy plan',()=>{const s=state([event({dose:50})]);assert.equal(M.slot(s,s.events[0]),'');});
test('occurrenceKey alone identifies the plan at a changed time',()=>{const s=state([event({minute:365,occurrenceKey:M.key(DAY,'cr1')})]);assert.equal(M.matches(s,DAY,'cr1').length,1);});
test('separate dose is not inferred into a scheduled occurrence',()=>{const s=state([event({entryKind:'extra'})]);assert.equal(M.matches(s,DAY,'cr1').length,0);});
test('new UUID on identical manual dose is blocked',()=>{const s=state([event()]);assert.throws(()=>apply(s,confirm({slot:''})),/이미 있습니다/);});
test('new UUID on identical extra dose needs explicit confirmation',()=>{const c=confirm({slot:''});c.mode='extra';assert.throws(()=>apply(state([event()]),c),/이미 있습니다/);});
test('explicit genuine additional identical dose is retained',()=>{const c=confirm({slot:'',confirmedDistinct:true});c.mode='extra';const s=apply(state([event()]),c);assert.equal(s.events.length,2);assert.equal(s.events[1].entryKind,'extra');assert.equal(s.events[1].distinctConfirmedAt,AT);});
test('same additional request retry is idempotent',()=>{const c=confirm({slot:'',confirmedDistinct:true});c.mode='extra';let s=apply(state([event()]),c);s=apply(s,c);assert.equal(s.events.length,2);});
test('extra dose at another time remains separate',()=>{const c=confirm({slot:'',time:'08:00'});c.mode='extra';const s=apply(state([event()]),c);assert.equal(s.events.length,2);assert.equal(s.events[1].entryKind,'extra');});
test('ID collision with changed payload is rejected',()=>{const old=event({slot:'cr1'});assert.throws(()=>apply(state([old]),confirm({id:old.id,time:'06:05'})),/번호/);});
test('stale correction rejected without mutating source',()=>{const s=state([event()]), c=correct(event());c.items[0].expected.dose=50;assert.throws(()=>apply(s,c),/다른 화면/);assert.equal(s.events[0].dose,100);});
test('invalid time rejected',()=>assert.throws(()=>apply(state(),confirm({time:'25:00'}))));
test('future dose rejected',()=>assert.throws(()=>apply(state(),confirm({time:'23:00'})),/지난 날짜/));
test('invalid calendar day rejected',()=>{const c=confirm();c.day='2026-02-30';assert.throws(()=>apply(state(),c),/지난 날짜/);});
test('unknown mode rejected',()=>{const c=confirm();c.mode='unexpected';assert.throws(()=>apply(state(),c));});
test('unknown scheduled slot rejected',()=>assert.throws(()=>apply(state(),confirm({slot:'missing'}))));
test('extra cannot carry scheduled slot',()=>{const c=confirm();c.mode='extra';assert.throws(()=>apply(state(),c));});
test('invalid batch leaves original completely unchanged',()=>{const s=state(), c=confirm();c.items.push({...c.items[0],id:'bad',slot:'prami',dose:0});assert.throws(()=>apply(s,c));assert.equal(s.events.length,0);});
test('JSON roundtrip keeps idempotency',()=>{let s=apply(state([event()]),confirm());s=JSON.parse(JSON.stringify(s));assert.equal(apply(s,confirm()).events.length,1);});
test('history never reappears as an actual event',()=>{const old=event(),s=state();M.audit(s,old,null,AT,'delete');assert.equal(s.events.length,0);assert.equal(M.matches(s,DAY,'cr1').length,0);});
test('read-only validation preserves prior duplicates',()=>{const s=state([event(),event({id:'second'})]);const before=JSON.stringify(s);C.validate(s);assert.equal(JSON.stringify(s),before);});
console.log(`\n${passed} medication regression tests passed.`);
