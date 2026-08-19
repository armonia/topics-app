// screenshot via CDP cosi' il viewport e' identico a Chrome
import { launch, CDP, newPage, sleep } from "./bench.mjs";
import { writeFileSync } from "node:fs";
const b=await launch("obscura",9482); const br=await CDP.connect(b.wsUrl); const {sessionId:s}=await newPage(br);
await br.send("Emulation.setDeviceMetricsOverride",{width:640,height:1100,deviceScaleFactor:1,mobile:false},s).catch(e=>console.log("emu:",e.message));
await br.send("Page.navigate",{url:"http://127.0.0.1:4700/"},s); await sleep(3000);
const sc=await br.send("Page.captureScreenshot",{format:"png"},s);
writeFileSync("vs/cases-obscura.png",Buffer.from(sc.data,"base64"));
const dims=await br.send("Runtime.evaluate",{expression:"[innerWidth,innerHeight,document.body.scrollHeight].join('x')",returnByValue:true},s);
console.log("obscura viewport:",dims.result?.value);
br.close();b.dispose();process.exit(0);
