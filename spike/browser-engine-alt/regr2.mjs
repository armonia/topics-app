import { spawn } from "node:child_process";
import { CDP, newPage, sleep } from "./bench.mjs";
const bin=process.argv[2],tag=process.argv[3],port=+process.argv[4];
const p=spawn(bin,["serve","--port",String(port),"--allow-private-network","--quiet"],{stdio:"ignore",detached:false});
let up=null; for(let i=0;i<160;i++){try{const r=await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(500)});if(r.ok){up=await r.json();break}}catch{} await sleep(60);}
if(!up){console.log(tag,"no cdp");p.kill(9);process.exit(0);}
const br=await CDP.connect(up.webSocketDebuggerUrl||`ws://127.0.0.1:${port}/devtools/browser`);
const {sessionId:s}=await newPage(br);
await br.send("Page.navigate",{url:"http://127.0.0.1:4701/"},s); await sleep(2200);
const r=await br.send("Runtime.evaluate",{expression:"JSON.stringify(window.__probe)",returnByValue:true},s);
console.log(tag,"|",r.result?.value);
br.close(); p.kill("SIGKILL"); setTimeout(()=>process.exit(0),200);
