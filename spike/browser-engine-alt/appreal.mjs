// L'app Topics VERA (https://127.0.0.1:3333, l'origine che usa l'app) su un engine CDP.
import { spawn, execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { CDP, newPage, sleep } from "./bench.mjs";
const rss=(pid)=>{const o=execSync("ps -Ao pid=,ppid=,rss=").toString();const k=new Map(),r=new Map();
 for(const l of o.split("\n")){const m=l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);if(!m)continue;
 r.set(+m[1],+m[3]);if(!k.has(+m[2]))k.set(+m[2],[]);k.get(+m[2]).push(+m[1]);}
 let t=0,s=[pid],seen=new Set();while(s.length){const p=s.pop();if(seen.has(p))continue;seen.add(p);
 if(r.has(p))t+=r.get(p);for(const c of k.get(p)||[])s.push(c);}return Math.round(t/1024);};
const bin=process.argv[2],tag=process.argv[3],port=+process.argv[4];
const p=spawn(bin,["serve","--port",String(port),"--allow-private-network","--quiet"],{stdio:"ignore"});
let up=null;for(let i=0;i<200;i++){try{const r=await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(500)});if(r.ok){up=await r.json();break}}catch{}await sleep(60);}
await sleep(600); const base=rss(p.pid);
const br=await CDP.connect(up.webSocketDebuggerUrl||`ws://127.0.0.1:${port}/devtools/browser`);
const {sessionId:s}=await newPage(br);
const errs=[]; await br.send("Runtime.enable",{},s).catch(()=>{});
br.on("Runtime.exceptionThrown",(e)=>errs.push(String(e.exceptionDetails?.exception?.description||e.exceptionDetails?.text||"").slice(0,100)));
await br.send("Security.setIgnoreCertificateErrors",{ignore:true},s).catch(()=>{});
await br.send("Emulation.setDeviceMetricsOverride",{width:1440,height:900,deviceScaleFactor:2,mobile:false},s).catch(()=>{});
await br.send("Page.navigate",{url:"http://127.0.0.1:4900/"},s);
await sleep(10000);
const loaded=rss(p.pid);
const r=await br.send("Runtime.evaluate",{expression:`JSON.stringify({
  title:document.title, nodes:document.querySelectorAll('*').length,
  text:(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,100)})`,returnByValue:true},s).catch(e=>({}));
console.log(`${tag}: base ${base} MB -> ${loaded} MB (app costa ${loaded-base} MB)`);
console.log("  ", r.result?.value);
console.log("   errori:", errs.length?errs.slice(0,3):"nessuno");
const sc=await br.send("Page.captureScreenshot",{format:"png"},s).catch(()=>null);
if(sc) writeFileSync(`vs/appreal-${tag}.png`,Buffer.from(sc.data,"base64"));
br.close(); p.kill("SIGKILL"); setTimeout(()=>process.exit(0),300);
