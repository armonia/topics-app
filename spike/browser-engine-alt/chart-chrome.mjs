import { launch, CDP, newPage, sleep } from "./bench.mjs";
import { writeFileSync } from "node:fs";
const b=await launch("headless-shell",9613); const br=await CDP.connect(b.wsUrl); const {sessionId:s}=await newPage(br);
await br.send("Emulation.setDeviceMetricsOverride",{width:700,height:300,deviceScaleFactor:1,mobile:false},s);
await br.send("Page.navigate",{url:"http://127.0.0.1:4703/"},s); await sleep(2500);
const probe=await br.send("Runtime.evaluate",{expression:"JSON.stringify(window.__probe)",returnByValue:true},s);
console.log("chrome", probe.result?.value);
const sc=await br.send("Page.captureScreenshot",{format:"png"},s);
writeFileSync("vs/chart-chrome.png",Buffer.from(sc.data,"base64")); br.close();b.dispose();process.exit(0);
