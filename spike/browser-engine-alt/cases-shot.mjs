import { launch, CDP, newPage, sleep } from "./bench.mjs";
import { writeFileSync } from "node:fs";
const b=await launch("headless-shell",9481); const br=await CDP.connect(b.wsUrl); const {sessionId:s}=await newPage(br);
await br.send("Emulation.setDeviceMetricsOverride",{width:640,height:1100,deviceScaleFactor:1,mobile:false},s);
await br.send("Page.navigate",{url:"http://127.0.0.1:4700/"},s); await sleep(2500);
const sc=await br.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:true},s);
writeFileSync("vs/cases-chrome.png",Buffer.from(sc.data,"base64")); br.close();b.dispose();process.exit(0);
