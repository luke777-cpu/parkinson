(function(root){
'use strict';
const C={version:1};
C.id=()=>globalThis.crypto?.randomUUID?.()||Date.now().toString(36)+Math.random().toString(36).slice(2);
C.day=(d=new Date())=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
C.minute=d=>d.getHours()*60+d.getMinutes();
C.clock=m=>`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
C.toMinute=s=>Number(s.slice(0,2))*60+Number(s.slice(3));
C.defaults=()=>({schema:'p1-lab',version:1,schedule:[
 {id:'cr1',name:'퍼킨 CR',dose:100,time:'06:00'},
 {id:'prami',name:'미라펙스 ER',dose:.375,time:'06:00'},
 {id:'aman1',name:'아만타딘',dose:100,time:'06:00'},
 {id:'ir',name:'퍼킨',dose:100,time:'07:20'},
 {id:'cr2',name:'퍼킨 CR',dose:100,time:'12:00'},
 {id:'maob',name:'아질렉트',dose:1,time:'12:00'},
 {id:'cr3',name:'퍼킨 CR',dose:100,time:'18:00'},
 {id:'aman2',name:'아만타딘',dose:100,time:'18:00'},
 {id:'rescue',name:'마도파 확산정',dose:100,time:'18:15'}],
 baseline:[{t:360,v:25},{t:440,v:25},{t:470,v:60},{t:505,v:90},{t:600,v:90},{t:750,v:55},{t:870,v:65},{t:960,v:65},{t:990,v:null},{t:1140,v:null},{t:1170,v:80},{t:1320,v:80},{t:1380,v:35},{t:1439,v:35}],
 events:[],forecasts:[]});
C.base=(points,t)=>{
 if(t<points[0].t||t>points.at(-1).t)return null;
 const exact=points.find(p=>p.t===t);if(exact)return exact.v;
 for(let i=1;i<points.length;i++){let a=points[i-1],b=points[i];if(t<b.t){if(a.v===null||b.v===null)return null;return a.v+(b.v-a.v)*(t-a.t)/(b.t-a.t);}}
 return null;
};
C.forecast=(state,now)=>{
 const day=C.day(now),minute=C.minute(now);
 const latest=state.events.filter(e=>e.type==='output'&&e.day===day&&e.minute<=minute&&minute-e.minute<=120).sort((a,b)=>b.minute-a.minute)[0];
 const reference=latest?C.base(state.baseline,latest.minute):null;
 const offset=reference===null?0:Math.max(-25,Math.min(25,latest.value-reference));
 return [30,60,120].map(h=>{
  const target=minute+h,b=C.base(state.baseline,target);
  if(target>1439||b===null)return null;
  const adaptive=Math.round(Math.max(0,Math.min(100,b+offset*Math.exp(-(target-(latest?.minute??minute))/90))));
  return {id:C.id(),createdAt:now.toISOString(),day,issuedMinute:minute,targetMinute:target,horizon:h,value:adaptive,baseline:Math.round(b),lastValue:latest?.value??null,method:reference===null?'평소 패턴':'평소 패턴 + 최근 출력 보정',inputEvent:latest?.id??null};
 }).filter(Boolean);
};
C.evaluate=(state)=>state.forecasts.flatMap(f=>{
 const at=new Date(f.createdAt).getTime();
 const choices=state.events.filter(e=>e.type==='output'&&e.day===f.day&&Math.abs(e.minute-f.targetMinute)<=15&&e.minute>f.issuedMinute&&new Date(e.createdAt).getTime()>at);
 choices.sort((a,b)=>Math.abs(a.minute-f.targetMinute)-Math.abs(b.minute-f.targetMinute));
 if(!choices.length)return [];
 const e=choices[0];return [{...f,actual:e.value,actualMinute:e.minute,error:Math.abs(f.value-e.value),baseError:Math.abs(f.baseline-e.value),holdError:f.lastValue===null?null:Math.abs(f.lastValue-e.value)}];
});
C.factors=['식사','수면 부족','변비','운동','이상운동증','동결'];
C.associations=(state)=>{
 const days=[...new Set(state.events.filter(e=>e.type==='output').map(e=>e.day))];
 const valid=days.map(day=>{
  const residuals=state.events.filter(e=>e.day===day&&e.type==='output').flatMap(e=>{const b=C.base(state.baseline,e.minute);return b===null?[]:[e.value-b];});
  return {day,delta:residuals.length>=3?residuals.reduce((a,b)=>a+b,0)/residuals.length:null};
 }).filter(d=>d.delta!==null);
 return C.factors.map(f=>{
  const yes=valid.filter(d=>state.events.some(e=>e.day===d.day&&e.type==='factor'&&e.factor===f));
  const no=valid.filter(d=>!state.events.some(e=>e.day===d.day&&e.type==='factor'&&e.factor===f));
  const mean=a=>a.reduce((s,x)=>s+x.delta,0)/a.length;
  return {factor:f,yes:yes.length,no:no.length,difference:yes.length>=3&&no.length>=3?Math.round(mean(yes)-mean(no)):null};
 });
};
C.validate=s=>{
 const fail=()=>{throw Error('P1 백업 형식 또는 값이 올바르지 않습니다.');};
 const finite=(x,a,b)=>typeof x==='number'&&Number.isFinite(x)&&x>=a&&x<=b;
 const str=(x,n=200)=>typeof x==='string'&&x.length<=n;
 const day=x=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(x))return false;const d=new Date(x+'T12:00:00');return !isNaN(d)&&C.day(d)===x;};
 const date=x=>typeof x==='string'&&Number.isFinite(Date.parse(x));
 if(!s||s.schema!=='p1-lab'||s.version!==1||!Array.isArray(s.events)||s.events.length>50000||!Array.isArray(s.forecasts)||s.forecasts.length>50000||!Array.isArray(s.schedule)||s.schedule.length>50||!Array.isArray(s.baseline)||s.baseline.length<2||s.baseline.length>100)fail();
 s.schedule.forEach(x=>{if(!str(x.id)||!str(x.name)||!finite(x.dose,.001,2000)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(x.time))fail();});
 s.baseline.forEach((x,i)=>{if(!Number.isInteger(x.t)||!finite(x.t,0,1439)||(x.v!==null&&!finite(x.v,0,100))||(i&&x.t<=s.baseline[i-1].t))fail();});
 s.events.forEach(e=>{
  if(!str(e.id)||!day(e.day)||!Number.isInteger(e.minute)||!finite(e.minute,0,1439)||!date(e.createdAt)||!str(e.note??'',1000))fail();
  if(e.type==='output'){if(!finite(e.value,0,100))fail();}
  else if(e.type==='med'){if(!str(e.name)||!finite(e.dose,.001,2000)||!str(e.slot??''))fail();}
  else if(e.type==='factor'){if(!C.factors.includes(e.factor)||!str(e.severity??''))fail();}
  else fail();
 });
 s.forecasts.forEach(f=>{if(!str(f.id)||!date(f.createdAt)||!day(f.day)||!finite(f.issuedMinute,0,1439)||!finite(f.targetMinute,0,1439)||f.targetMinute<=f.issuedMinute||!finite(f.value,0,100)||!finite(f.baseline,0,100)||(f.lastValue!==null&&!finite(f.lastValue,0,100))||!str(f.method))fail();});
 for(const list of [s.events,s.forecasts,s.schedule])if(new Set(list.map(x=>x.id)).size!==list.length)fail();
 return s;
};
if(typeof module!=='undefined')module.exports=C;root.P1=C;
})(globalThis);
