// This registration controls only /p1-lab/. It never unregisters the diary worker.
if('serviceWorker' in navigator&&location.protocol==='https:'){
 navigator.serviceWorker.register('./sw.js',{scope:'./'}).catch(()=>{});
 // Refresh an older parent worker which cached all navigation under its index.
 navigator.serviceWorker.getRegistrations().then(regs=>{
  const parent=new URL('../',location.href).href;
  regs.filter(r=>r.scope===parent).forEach(r=>r.update().catch(()=>{}));
 }).catch(()=>{});
}
