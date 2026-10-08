import { chromium } from "playwright";
const b = await chromium.launch();
const html = `<style>body{margin:0}#sc{height:400px;overflow:auto}.row{height:100px;border:1px solid #ccc}#foot{height:60px;background:red}</style>
<div id=sc><div id=list>${'<div class=row>r</div>'.repeat(10)}</div><div id=foot>footer</div></div>
<script>
window.shifts=[];new PerformanceObserver(l=>{for(const e of l.getEntries())window.shifts.push(e.value)}).observe({type:'layout-shift',buffered:true});
const sc=document.getElementById('sc');sc.scrollTop=sc.scrollHeight;
window.grow=(mode)=>{const d=document.createElement('div');d.className='row';d.style.height='300px';
 if(mode==='ro'){const ro=new ResizeObserver(()=>{sc.scrollTop=sc.scrollHeight;ro.disconnect()});ro.observe(document.getElementById('list'));}
 document.getElementById('list').appendChild(d);
 if(mode==='sync'){sc.scrollTop=sc.scrollHeight;}
 if(mode==='raf'){requestAnimationFrame(()=>{sc.scrollTop=sc.scrollHeight})}
};
</script>`;
for (const mode of ["sync", "ro", "raf", "none"]) {
  const p = await b.newPage();
  await p.setContent(html);
  await p.waitForTimeout(300);
  await p.evaluate(() => { window.shifts.length = 0; });
  await p.evaluate((m) => window.grow(m), mode);
  await p.waitForTimeout(500);
  console.log(mode, JSON.stringify(await p.evaluate(() => window.shifts)));
  await p.close();
}
await b.close();
