import { launch, CDP, newPage, sleep, now } from "./bench.mjs";
const engine=process.argv[2], port=+process.argv[3];
const b=await launch(engine,port); const br=await CDP.connect(b.wsUrl); const {sessionId:s}=await newPage(br);
await br.send("Page.enable",{},s).catch(()=>{});
let frames=0,bytes=0,first=null;
br.on("Page.screencastFrame",p=>{frames++;bytes+=p.data.length*0.75;if(!first)first=now();br.send("Page.screencastFrameAck",{sessionId:p.sessionId},s).catch(()=>{})});
await br.send("Page.navigate",{url:"http://127.0.0.1:4599/"},s); await sleep(2000);
const t0=now();
try{ await br.send("Page.startScreencast",{format:"jpeg",quality:70,everyNthFrame:1,maxWidth:1280,maxHeight:720},s); }catch(e){ console.log(engine,"startScreencast ERR",e.message); process.exit(0); }
await sleep(5000);
await br.send("Page.stopScreencast",{},s).catch(()=>{});
console.log(JSON.stringify({engine,frames,fps:+(frames/5).toFixed(1),kbFrame:frames?+(bytes/frames/1024).toFixed(1):0,mbps:+(bytes/5/1024/1024).toFixed(2),firstFrameMs:first?+(first-t0).toFixed(0):null}));
br.close();b.dispose();process.exit(0);
