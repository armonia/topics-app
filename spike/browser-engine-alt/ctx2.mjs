import { launch, CDP, treeRssMB, sleep } from "./bench.mjs";
const engine=process.argv[2], n=+process.argv[3], url=process.argv[4], port=+process.argv[5];
const b=await launch(engine,port); const br=await CDP.connect(b.wsUrl); await sleep(500);
const base=treeRssMB(b.proc.pid); const ss=[];
for(let i=0;i<n;i++){ let c=null; try{({browserContextId:c}=await br.send("Target.createBrowserContext",{}));}catch{}
  const {targetId}=await br.send("Target.createTarget", c?{url:"about:blank",browserContextId:c}:{url:"about:blank"});
  const {sessionId}=await br.send("Target.attachToTarget",{targetId,flatten:true}); ss.push(sessionId); }
await Promise.all(ss.map(s=>br.send("Page.navigate",{url},s).catch(()=>{})));
await sleep(7000);
const L=treeRssMB(b.proc.pid);
console.log(JSON.stringify({engine,n,url,baseMB:base.mb,loadedMB:L.mb,perSessionMB:+((L.mb-base.mb)/n).toFixed(1),procs:L.procs}));
br.close();b.dispose();process.exit(0);
