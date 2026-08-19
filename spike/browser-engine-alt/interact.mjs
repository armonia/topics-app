// Test "caso Topics": app dev locale — click, input, DOM read, screenshot dopo interazione.
import { launch, CDP, newPage, treeRssMB, sleep, now } from "./bench.mjs";
import { writeFileSync, appendFileSync } from "node:fs";

const engine = process.argv[2];
const port = +(process.argv[3] || 9600);
const URL = "http://127.0.0.1:4599/";
const out = "interact.jsonl";
const log = (o) => { const r = JSON.stringify({ engine, ...o }); appendFileSync(out, r + "\n"); console.log(r); };

const b = await launch(engine, port);
const br = await CDP.connect(b.wsUrl);
const { sessionId: s } = await newPage(br);
const ev = async (expr) => (await br.send("Runtime.evaluate", { expression: expr, returnByValue: true }, s)).result?.value;

try { await br.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false }, s); } catch {}
await br.send("Page.enable", {}, s).catch(() => {});
await br.send("DOM.enable", {}, s).catch(() => {});
await br.send("Page.navigate", { url: URL }, s);
await sleep(2500);

const checks = {};
checks.ready = await ev("window.__ready === true").catch((e) => "ERR " + e.message);
checks.cards = await ev("document.querySelectorAll('.card').length").catch((e) => "ERR " + e.message);
checks.countText = await ev("document.getElementById('count').textContent").catch((e) => "ERR " + e.message);
checks.canvasPainted = await ev("(()=>{const c=document.getElementById('cv');const d=c.getContext('2d').getImageData(0,0,300,120).data;let nz=0;for(let i=0;i<d.length;i+=4){if(d[i]>20||d[i+1]>20||d[i+2]>30)nz++}return nz})()").catch((e) => "ERR " + String(e.message).slice(0, 50));
checks.computedGrid = await ev("getComputedStyle(document.getElementById('g')).display").catch((e) => "ERR " + String(e.message).slice(0, 50));
checks.cardRect = await ev("JSON.stringify(document.querySelector('.card').getBoundingClientRect())").catch((e) => "ERR " + String(e.message).slice(0, 50));
log({ phase: "load", ...checks });

// DOM.getDocument + querySelector (percorso usato da un tool dispatcher)
try {
  const { root } = await br.send("DOM.getDocument", { depth: 1 }, s);
  const q = await br.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#add" }, s);
  const box = await br.send("DOM.getBoxModel", { nodeId: q.nodeId }, s).catch((e) => ({ err: e.message }));
  log({ phase: "dom-api", nodeId: q.nodeId, box: box.model ? box.model.content.slice(0, 4) : box.err });
} catch (e) { log({ phase: "dom-api", error: String(e.message).slice(0, 100) }); }

// click reale su coordinate del bottone "Aggiungi"
try {
  const r = JSON.parse(await ev("JSON.stringify(document.getElementById('add').getBoundingClientRect())"));
  const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
  const before = await ev("document.querySelectorAll('.card').length");
  await br.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, s);
  await br.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, s);
  await sleep(400);
  const after = await ev("document.querySelectorAll('.card').length");
  log({ phase: "click", x, y, before, after, worked: after === before + 1 });
} catch (e) { log({ phase: "click", error: String(e.message).slice(0, 120) }); }

// typing nel filtro
try {
  const r = JSON.parse(await ev("JSON.stringify(document.getElementById('q').getBoundingClientRect())"));
  await br.send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(r.x + 20), y: Math.round(r.y + r.height / 2), button: "left", clickCount: 1 }, s);
  await br.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(r.x + 20), y: Math.round(r.y + r.height / 2), button: "left", clickCount: 1 }, s);
  for (const ch of "Task 3") {
    await br.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch }, s).catch(() => {});
    await br.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch }, s).catch(() => {});
  }
  await sleep(400);
  const val = await ev("document.getElementById('q').value");
  const visible = await ev("[...document.querySelectorAll('.card')].filter(c=>c.style.display!=='none').length");
  log({ phase: "type", value: val, visibleCards: visible, worked: val === "Task 3" });
} catch (e) { log({ phase: "type", error: String(e.message).slice(0, 120) }); }

// screenshot post-interazione
try {
  const sc = await br.send("Page.captureScreenshot", { format: "png" }, s);
  writeFileSync(`shots/app-${engine}.png`, Buffer.from(sc.data, "base64"));
  log({ phase: "shot", bytes: Buffer.from(sc.data, "base64").length });
} catch (e) { log({ phase: "shot", error: String(e.message).slice(0, 100) }); }

log({ phase: "rss-final", ...treeRssMB(b.proc.pid) });
br.close(); b.dispose(); process.exit(0);
