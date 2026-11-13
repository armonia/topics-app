import { launch, CDP, newPage, sleep } from "./bench.mjs";
import { writeFileSync } from "node:fs";
const engine=process.argv[2], port=+process.argv[3], url=process.argv[4]||"http://127.0.0.1:4599/";
const b=await launch(engine,port); const br=await CDP.connect(b.wsUrl); const {sessionId:s}=await newPage(br);
let metricsOverride=true;
try{await br.send("Emulation.setDeviceMetricsOverride",{width:1280,height:720,deviceScaleFactor:1,mobile:false},s);}catch(e){metricsOverride=false;console.warn("[layout] viewport override failed, boxes may not be comparable:",e.message);}
await br.send("Page.navigate",{url},s); await sleep(3500);
const ev=async e=>(await br.send("Runtime.evaluate",{expression:e,returnByValue:true},s)).result?.value;
const boxes=await ev(`JSON.stringify([...document.querySelectorAll('a,button,input,h1,h2,h3,img,li')].slice(0,60).map(e=>{const r=e.getBoundingClientRect();return{t:e.tagName,x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),tx:(e.textContent||'').trim().slice(0,22)}}))`);
const parsedBoxes=JSON.parse(boxes||"[]");
writeFileSync(`layout-${engine}-${url.replace(/\W+/g,'_').slice(0,30)}.json`, JSON.stringify({metricsOverride,boxes:parsedBoxes}));
console.log(engine, url, "elems", parsedBoxes.length);
br.close();b.dispose();process.exit(0);
