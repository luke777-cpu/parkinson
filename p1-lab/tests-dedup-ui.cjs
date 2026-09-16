'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
class Element {
 constructor(){this.hidden=false;this.disabled=false;this.checked=false;this.children=[];this.textContent='';}
 append(...items){this.children.push(...items);}
 before(item){this.beforeItem=item;}
 setAttribute(k,v){this[k]=v;}
}
const elements={medFields:new Element(),meds:new Element()},buttons=[new Element(),new Element()],head=new Element();
head.textContent='P1 v1.1.0';
const ctx=vm.createContext({console,structuredClone,setTimeout,clearTimeout,Date,Math,Promise,document:{createElement:()=>new Element(),querySelectorAll:q=>q==='header small, footer'?[head]:buttons},elements});
vm.runInContext(fs.readFileSync(__dirname+'/core.js','utf8'),ctx);
vm.runInContext(fs.readFileSync(__dirname+'/medication.js','utf8'),ctx);
vm.runInContext(`
const $=id=>elements[id];let state=P1.defaults(),medicationBusy=false,message='';
const toast=text=>{message=text;};const dayEvents=()=>state.events;
function renderMeds(){}
function openEditor(){}
function commitEvent(event){const i=state.events.findIndex(e=>e.id===event.id);if(i<0)state.events.push(event);else state.events[i]=event;return true;}
let captured=[];
async function persistMedication(commands){medicationBusy=true;try{await new Promise(r=>setTimeout(r,5));captured=commands;return true;}finally{medicationBusy=false;}}
`,ctx);
vm.runInContext(fs.readFileSync(__dirname+'/dedup-ui.js','utf8'),ctx);
const run=code=>vm.runInContext(code,ctx);let n=0;
function test(name,code){assert.equal(run(code),true,name);console.log('PASS '+name);n++;}
(async()=>{
 test('output repeat with a new UUID is one event',`(()=>{state.events=[];const e={id:'a',type:'output',day:'2026-09-16',minute:360,value:50,note:''};commitEvent(e);return commitEvent({...e,id:'b'})===false&&state.events.length===1;})()`);
 test('same time changed output requires correction',`commitEvent({...state.events[0],id:'c',value:70})===false&&state.events[0].value===50`);
 test('same output ID correction remains one event',`commitEvent({...state.events[0],value:70})===true&&state.events.length===1&&state.events[0].value===70`);
 test('next observation time is retained',`commitEvent({...state.events[0],id:'next',minute:370})===true&&state.events.length===2`);
 test('legacy medication cannot be added again through commitEvent',`(()=>{state.events=[{id:'legacy',type:'med',day:'2026-09-16',minute:360,name:'퍼킨 CR',dose:100,slot:''}];return commitEvent({...state.events[0],id:'new',slot:'cr1'})===false&&state.events.length===1;})()`);
 test('dose duplicate is blocked in the undo/commit path',`commitEvent({...state.events[0],id:'manual'})===false&&state.events.length===1`);
 test('render shows actual stored count',`(()=>{renderMeds();return elements.meds.beforeItem.textContent.includes('복약 1건');})()`);
 test('version label updated',`document.querySelectorAll('header small, footer')[0].textContent==='P1 v1.1.1'`);
 test('extra confirmation resets for every editor open',`(()=>{const box=elements.medFields.children[0].children[0];box.checked=true;openEditor('med');return !box.checked&&!elements.medFields.children[0].hidden;})()`);
 test('correction hides additional-dose control',`(()=>{openEditor('med',{id:'existing'});return elements.medFields.children[0].hidden;})()`);
 await run(`persistMedication([{mode:'confirm',day:'2026-09-16',items:[{id:'new',slot:''}]}])`);
 test('manual addition is explicitly marked extra',`captured[0].mode==='extra'&&captured[0].items[0].confirmedDistinct===false`);
 test('save buttons restored after completion',`document.querySelectorAll('buttons').every(b=>b.disabled===false)`);
 const first=run(`persistMedication([{mode:'confirm',items:[{id:'a',slot:'cr1'}]}])`);
 test('buttons disabled during write',`document.querySelectorAll('buttons').every(b=>b.disabled===true)`);
 assert.equal(await run(`persistMedication([{mode:'confirm',items:[{id:'b',slot:'cr1'}]}])`),false);n++;console.log('PASS concurrent second submit refused');await first;
 test('scheduled group is not converted into extra',`captured[0].mode==='confirm'&&captured[0].items[0].slot==='cr1'`);
 console.log(`\n${n} UI-guard regression tests passed (DOM test harness).`);
})().catch(e=>{console.error(e);process.exitCode=1;});
