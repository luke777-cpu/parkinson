// P1-only worker; no access to diary registrations or storage.
if('serviceWorker' in navigator&&location.protocol==='https:'){
 navigator.serviceWorker.register('./sw.js',{scope:'./',updateViaCache:'none'}).then(r=>r.update()).catch(()=>{});
}
