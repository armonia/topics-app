import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { CDP, newPage, sleep } from "./bench.mjs";
const bin=process.argv[2], tag=process.argv[3], port=+process.argv[4];
const p=spawn(bin,["serve","--port",String(port),"--allow-private-network","--quiet"],{stdio:["ignore","ignore","pipe"]});
let up=null; for(let i=0;i<200;i++){ try{const r=await fetch(`http://127.0.0.1:${port}/json/version`);if(r.ok){up=await r.json();break}}catch{} await sleep(50); }
if(!up){ console.log(tag,"NO CDP"); p.kill(9); process.exit(1); }
const br=await CDP.connect(up.webSocketDebuggerUrl||`ws://127.0.0.1:${port}/devtools/browser`);
const {sessionId:s}=await newPage(br);
await br.send("Emulation.setDeviceMetricsOverride",{width:700,height:300,deviceScaleFactor:1,mobile:false},s).catch(()=>{});
await br.send("Page.navigate",{url:"http://127.0.0.1:4703/"},s); await sleep(3000);
const probe=await br.send("Runtime.evaluate",{expression:"JSON.stringify(window.__probe)",returnByValue:true},s);
console.log(tag, probe.result?.value);
const sc=await br.send("Page.captureScreenshot",{format:"png"},s);
writeFileSync(`vs/chart-${tag}.png`,Buffer.from(sc.data,"base64"));
br.close(); p.kill(9); process.exit(0);
