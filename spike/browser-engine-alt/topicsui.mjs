import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { CDP, newPage, sleep } from "./bench.mjs";
const bin=process.argv[2],tag=process.argv[3],port=+process.argv[4];
const p=spawn(bin,["serve","--port",String(port),"--allow-private-network","--quiet"],{stdio:"ignore"});
let up=null; for(let i=0;i<160;i++){try{const r=await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(500)});if(r.ok){up=await r.json();break}}catch{} await sleep(60);}
const br=await CDP.connect(up.webSocketDebuggerUrl||`ws://127.0.0.1:${port}/devtools/browser`);
const {sessionId:s}=await newPage(br);
const errs=[];
await br.send("Runtime.enable",{},s).catch(()=>{});
br.on("Runtime.exceptionThrown",(e)=>errs.push(String(e.exceptionDetails?.exception?.description||e.exceptionDetails?.text||"").slice(0,120)));
await br.send("Emulation.setDeviceMetricsOverride",{width:1280,height:800,deviceScaleFactor:1,mobile:false},s).catch(()=>{});
await br.send("Page.navigate",{url:"http://127.0.0.1:4800/"},s); await sleep(6000);
const r=await br.send("Runtime.evaluate",{expression:`JSON.stringify({
  title: document.title,
  nodes: document.querySelectorAll('*').length,
  rootChildren: (document.getElementById('root')||document.body).children.length,
  reactMounted: !!document.querySelector('[data-reactroot],#root>*'),
  bodyText: (document.body.innerText||'').slice(0,120)
})`,returnByValue:true},s);
console.log(tag,"|",r.result?.value);
console.log("  errori JS:", errs.length ? errs.slice(0,5) : "nessuno");
const sc=await br.send("Page.captureScreenshot",{format:"png"},s).catch(()=>null);
if(sc) writeFileSync(`vs/topicsui-${tag}.png`,Buffer.from(sc.data,"base64"));
br.close(); p.kill("SIGKILL"); setTimeout(()=>process.exit(0),200);
