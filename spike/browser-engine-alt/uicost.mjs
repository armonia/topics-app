import { spawn, execSync } from "node:child_process";
import { CDP, newPage, sleep, now } from "./bench.mjs";
const rss=(pid)=>{const o=execSync("ps -Ao pid=,ppid=,rss=").toString();const k=new Map(),r=new Map();
 for(const l of o.split("\n")){const m=l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);if(!m)continue;
 r.set(+m[1],+m[3]);if(!k.has(+m[2]))k.set(+m[2],[]);k.get(+m[2]).push(+m[1]);}
 let t=0,s=[pid],seen=new Set();while(s.length){const p=s.pop();if(seen.has(p))continue;seen.add(p);
 if(r.has(p))t+=r.get(p);for(const c of k.get(p)||[])s.push(c);}return Math.round(t/1024);};
const bin=process.argv[2],port=+process.argv[3];
const p=spawn(bin,["serve","--port",String(port),"--allow-private-network","--quiet"],{stdio:"ignore"});
let up=null;for(let i=0;i<160;i++){try{const r=await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(500)});if(r.ok){up=await r.json();break}}catch{}await sleep(60);}
await sleep(600); const base=rss(p.pid);
const br=await CDP.connect(up.webSocketDebuggerUrl||`ws://127.0.0.1:${port}/devtools/browser`);
const {sessionId:s}=await newPage(br);
await br.send("Emulation.setDeviceMetricsOverride",{width:1440,height:900,deviceScaleFactor:2,mobile:false},s).catch(()=>{});
await br.send("Page.navigate",{url:"http://127.0.0.1:4800/"},s); await sleep(6000);
const loaded=rss(p.pid);
console.log(`UI di Topics su Obscura: base ${base} MB -> ${loaded} MB (la UI costa ${loaded-base} MB)`);
// il ciclo che servirebbe per DISEGNARLA in finestra: screencast continuo
let f=0,bytes=0; br.on("Page.screencastFrame",(q)=>{f++;bytes+=q.data.length*0.75;
  br.send("Page.screencastFrameAck",{sessionId:q.sessionId},s).catch(()=>{})});
await br.send("Page.startScreencast",{format:"jpeg",quality:80,everyNthFrame:1,maxWidth:1440,maxHeight:900},s).catch(e=>console.log("cast err",e.message));
// simulo attivita' UI continua (come uno scroll o un cursore che lampeggia)
await br.send("Runtime.evaluate",{expression:"(()=>{const d=document.createElement('div');d.style.cssText='position:fixed;top:0;left:0;width:200px;height:60px;background:#f00';document.body.appendChild(d);let i=0;setInterval(()=>{d.style.transform=`translateX(${(i=(i+7)%400)}px)`},16)})()"},s).catch(()=>{});
await sleep(5000);
await br.send("Page.stopScreencast",{},s).catch(()=>{});
console.log(`ciclo di disegno in finestra: ${(f/5).toFixed(1)} fps, ${(bytes/5/1024/1024).toFixed(2)} MB/s di traffico`);
console.log(`RSS durante il disegno: ${rss(p.pid)} MB`);
br.close(); p.kill("SIGKILL"); setTimeout(()=>process.exit(0),300);
