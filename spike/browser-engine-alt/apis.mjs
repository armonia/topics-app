import { spawn } from "node:child_process";
import { CDP, newPage, sleep } from "./bench.mjs";
const bin=process.argv[2],tag=process.argv[3],port=+process.argv[4];
const p=spawn(bin,["serve","--port",String(port),"--allow-private-network","--quiet"],{stdio:"ignore"});
let up=null; for(let i=0;i<160;i++){try{const r=await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(500)});if(r.ok){up=await r.json();break}}catch{} await sleep(60);}
const br=await CDP.connect(up.webSocketDebuggerUrl||`ws://127.0.0.1:${port}/devtools/browser`);
const {sessionId:s}=await newPage(br);
await br.send("Page.navigate",{url:"data:text/html,<body><div id=x>hi</div></body>"},s); await sleep(1200);
const expr = `JSON.stringify({
  // React 19 / scheduler
  IntersectionObserver: typeof IntersectionObserver,
  ResizeObserver: typeof ResizeObserver,
  MutationObserver: typeof MutationObserver,
  requestIdleCallback: typeof requestIdleCallback,
  queueMicrotask: typeof queueMicrotask,
  // xterm (terminale): canvas/webgl + misura testo
  WebGL: (()=>{try{return !!document.createElement('canvas').getContext('webgl')}catch{return false}})(),
  canvas2d: (()=>{try{return !!document.createElement('canvas').getContext('2d')}catch{return false}})(),
  measureText: (()=>{try{const c=document.createElement('canvas').getContext('2d');return c.measureText('M').width>0}catch{return false}})(),
  // CodeMirror
  Range: typeof Range, getSelection: typeof getSelection,
  ClipboardEvent: typeof ClipboardEvent,
  // Tailwind 4 / CSS moderno
  CSSsupports: typeof CSS!=='undefined'&&typeof CSS.supports==='function',
  colorMix: (()=>{try{return CSS.supports('color','color-mix(in srgb, red, blue)')}catch{return false}})(),
  oklch: (()=>{try{return CSS.supports('color','oklch(70% .1 200)')}catch{return false}})(),
  cssVars: (()=>{try{return CSS.supports('color','var(--x)')}catch{return false}})(),
  // rendering/animazione
  rAF: typeof requestAnimationFrame,
  WebSocket: typeof WebSocket,
  fetch: typeof fetch,
  localStorage: typeof localStorage,
  customElements: typeof customElements,
  ShadowRoot: typeof ShadowRoot,
  matchMedia: typeof matchMedia,
  getBoundingClientRect: typeof document.getElementById('x').getBoundingClientRect
})`;
const r=await br.send("Runtime.evaluate",{expression:expr,returnByValue:true},s);
console.log(tag); const o=JSON.parse(r.result?.value||"{}");
for (const [k,v] of Object.entries(o)) console.log(`  ${String(v)==='undefined'||v===false?'MANCA ':'ok    '} ${k}: ${v}`);
br.close(); p.kill("SIGKILL"); setTimeout(()=>process.exit(0),200);
