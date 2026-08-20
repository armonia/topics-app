import { launch, CDP, newPage, sleep } from "./bench.mjs";
import { writeFileSync } from "node:fs";
const b=await launch("headless-shell",9712); const br=await CDP.connect(b.wsUrl); const {sessionId:s}=await newPage(br);
await br.send("Emulation.setDeviceMetricsOverride",{width:1280,height:800,deviceScaleFactor:1,mobile:false},s);
await br.send("Page.navigate",{url:"http://127.0.0.1:4800/"},s); await sleep(5000);
const r=await br.send("Runtime.evaluate",{expression:`JSON.stringify({title:document.title,nodes:document.querySelectorAll('*').length,rootChildren:(document.getElementById('root')||document.body).children.length,bodyText:(document.body.innerText||'').slice(0,120)})`,returnByValue:true},s);
console.log("chrome |",r.result?.value);
const sc=await br.send("Page.captureScreenshot",{format:"png"},s);
writeFileSync("vs/topicsui-chrome.png",Buffer.from(sc.data,"base64")); br.close();b.dispose();process.exit(0);
