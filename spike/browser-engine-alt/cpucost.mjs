import { spawn, execSync } from "node:child_process";
import { CDP, newPage, sleep } from "./bench.mjs";
const cpu=(pid)=>{try{return parseFloat(execSync(`ps -o %cpu= -p ${pid}`).toString().trim())}catch{return -1}};
const bin=process.argv[2],port=+process.argv[3];
const p=spawn(bin,["serve","--port",String(port),"--allow-private-network","--quiet"],{stdio:"ignore"});
let up=null;for(let i=0;i<160;i++){try{const r=await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(500)});if(r.ok){up=await r.json();break}}catch{}await sleep(60);}
const br=await CDP.connect(up.webSocketDebuggerUrl||`ws://127.0.0.1:${port}/devtools/browser`);
const {sessionId:s}=await newPage(br);
await br.send("Emulation.setDeviceMetricsOverride",{width:1440,height:900,deviceScaleFactor:2,mobile:false},s).catch(()=>{});
await br.send("Page.navigate",{url:"http://127.0.0.1:4800/"},s); await sleep(4000);
await br.send("Runtime.evaluate",{expression:"(()=>{const d=document.createElement('div');d.style.cssText='position:fixed;top:0;left:0;width:200px;height:60px;background:#f00';document.body.appendChild(d);let i=0;setInterval(()=>{d.style.transform=`translateX(${(i=(i+7)%400)}px)`},16)})()"},s).catch(()=>{});
await sleep(2000);
// CPU SENZA screencast: e' il costo di far girare la UI animata
let sum=0; for(let i=0;i<5;i++){await sleep(700); sum+=cpu(p.pid);}
console.log(`obscura, UI animata SENZA cattura: ${(sum/5).toFixed(1)}% CPU`);
let f=0; br.on("Page.screencastFrame",(q)=>{f++;br.send("Page.screencastFrameAck",{sessionId:q.sessionId},s).catch(()=>{})});
await br.send("Page.startScreencast",{format:"jpeg",quality:80,everyNthFrame:1,maxWidth:1440,maxHeight:900},s).catch(()=>{});
sum=0; for(let i=0;i<5;i++){await sleep(700); sum+=cpu(p.pid);}
console.log(`obscura, CON cattura a ${(f/3.5).toFixed(0)} fps: ${(sum/5).toFixed(1)}% CPU`);
br.close(); p.kill("SIGKILL"); setTimeout(()=>process.exit(0),300);
