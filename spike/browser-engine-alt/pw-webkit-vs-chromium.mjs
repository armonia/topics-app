import { webkit, chromium } from 'playwright-core';
import { execSync } from 'child_process';
import http from 'http';
const snap=()=>{const o=execSync('ps -Ao pid,rss').toString().trim().split('\n').slice(1);const m=new Map();for(const l of o){const[p,r]=l.trim().split(/\s+/);m.set(+p,+r)}return m};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const mbNew=(b,n)=>{let s=0;for(const[p,r]of n)if(!b.has(p))s+=r;return Math.round(s/1024)};
const srv=http.createServer((q,r)=>{r.writeHead(200,{'content-type':'text/html'});r.end('<h1>pane</h1>')}).listen(4613);
// Stessi flag del browser remoto vero (server/browser-service.ts:718)
const opts={headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']};
async function bench(L,n,o){
  const before=snap(); const b=await L.launch(o); const marks=[];
  for(let i=0;i<n;i++){ const c=await b.newContext(); const p=await c.newPage();
    await p.goto('http://127.0.0.1:4613/',{waitUntil:'load',timeout:30000}).catch(()=>{});
    await sleep(700); marks.push(mbNew(before,snap())); }
  await b.close(); await sleep(2500);
  return {marks, leaked:mbNew(before,snap())};
}
const n=6;
for(const[name,L,o] of [['webkit',webkit,{headless:true}],['chromium',chromium,opts]]){
  const r=await bench(L,n,o);
  console.log(`${name.padEnd(9)} 1a:${String(r.marks[0]).padStart(4)} MB → ${n}: ${String(r.marks[n-1]).padStart(4)} MB | marginale ${((r.marks[n-1]-r.marks[0])/(n-1)).toFixed(0)} MB/pane | residuo ${r.leaked}`);
}
srv.close();
