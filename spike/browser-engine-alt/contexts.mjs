// Costo marginale di N context nello STESSO browser (il modello di Topics)
import { launch, CDP, treeRssMB, sleep } from "./bench.mjs";
const engine=process.argv[2]||"headless-shell", n=+(process.argv[3]||8), port=+(process.argv[4]||9250);
const b=await launch(engine,port); const br=await CDP.connect(b.wsUrl);
await sleep(500);
const base=treeRssMB(b.proc.pid);
console.log(JSON.stringify({engine,phase:"base",...base}));
const sessions=[];
for(let i=0;i<n;i++){
  let ctxId=null;
  try{ ({browserContextId:ctxId} = await br.send("Target.createBrowserContext",{})); }catch(e){ /* no context support */ }
  const {targetId}=await br.send("Target.createTarget", ctxId?{url:"about:blank",browserContextId:ctxId}:{url:"about:blank"});
  const {sessionId}=await br.send("Target.attachToTarget",{targetId,flatten:true});
  sessions.push(sessionId);
}
await sleep(500);
const blank=treeRssMB(b.proc.pid);
console.log(JSON.stringify({engine,phase:"n-blank",n,...blank,marginalMB:+((blank.mb-base.mb)/n).toFixed(1)}));
await Promise.all(sessions.map(s=>br.send("Page.navigate",{url:"https://en.wikipedia.org/wiki/Web_browser"},s).catch(()=>{})));
await sleep(6000);
const loaded=treeRssMB(b.proc.pid);
console.log(JSON.stringify({engine,phase:"n-loaded",n,...loaded,marginalMB:+((loaded.mb-base.mb)/n).toFixed(1)}));
br.close();b.dispose();process.exit(0);
