#!/usr/bin/env bun
// Feasibility gate for the WebRTC-over-CDP shared-browser sidecar.
// Measures the REAL frame rate the CDP screencast can deliver — this is the
// source-fps ceiling that gates the whole design. Creates a throwaway target
// (does NOT touch Topics' live contexts) and tears it down.
//
// Usage: bun spike/webrtc-cdp/measure-fps.mjs [everyNthFrame]

const CDP = "http://127.0.0.1:19222";
const everyNthFrame = Number(process.argv[2] ?? 1);
const DURATION_MS = 6000;

function rpc(ws, id, method, params, sessionId) {
  const msg = { id, method, params: params ?? {} };
  if (sessionId) msg.sessionId = sessionId;
  ws.send(JSON.stringify(msg));
}

const ver = await fetch(`${CDP}/json/version`).then((r) => r.json());
const browserWs = ver.webSocketDebuggerUrl;
console.log(`[fps] CDP ${ver.Browser}  everyNthFrame=${everyNthFrame}`);

const ws = new WebSocket(browserWs);
let nextId = 1;
const pending = new Map();
function call(method, params, sessionId) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    rpc(ws, id, method, params, sessionId);
  });
}

let frames = 0;
let firstFrameAt = 0;
let lastFrameAt = 0;
let totalBytes = 0;
let sessionId = null;
let targetId = null;

ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.reject(new Error(JSON.stringify(m.error)));
    else p.resolve(m.result);
    return;
  }
  if (m.method === "Page.screencastFrame") {
    const now = performance.now();
    if (!firstFrameAt) firstFrameAt = now;
    lastFrameAt = now;
    frames++;
    totalBytes += (m.params.data?.length ?? 0) * 0.75; // base64 → bytes
    // ACK immediately (flow control) — same as browser-service.ts
    rpc(ws, nextId++, "Page.screencastFrameAck", { sessionId: m.params.sessionId }, sessionId);
  }
});

ws.addEventListener("open", async () => {
  try {
    const t = await call("Target.createTarget", { url: "about:blank" });
    targetId = t.targetId;
    const at = await call("Target.attachToTarget", { targetId, flatten: true });
    sessionId = at.sessionId;

    await call("Page.enable", {}, sessionId);
    await call("Emulation.setDeviceMetricsOverride",
      { width: 1280, height: 720, deviceScaleFactor: 2, mobile: false }, sessionId);
    // A continuously-animating page to force max compositor output.
    await call("Page.navigate", {
      url: "data:text/html," + encodeURIComponent(`<style>body{margin:0;background:#111}
        .b{position:absolute;width:80px;height:80px;border-radius:50%;background:hsl(0,80%,60%)}</style>
        <div class=b></div><script>const b=document.querySelector('.b');let a=0;
        function f(){a+=0.05;b.style.left=(640+400*Math.cos(a))+'px';b.style.top=(360+240*Math.sin(a*1.3))+'px';
        b.style.background='hsl('+((a*40)%360)+',80%,60%)';requestAnimationFrame(f)}f()</script>`),
    }, sessionId);
    await new Promise((r) => setTimeout(r, 400));

    await call("Page.startScreencast",
      { format: "jpeg", quality: 60, maxWidth: 2560, maxHeight: 1440, everyNthFrame }, sessionId);

    setTimeout(async () => {
      await call("Page.stopScreencast", {}, sessionId).catch(() => {});
      const span = (lastFrameAt - firstFrameAt) / 1000 || 1;
      const fps = (frames - 1) / span;
      const kbPerFrame = totalBytes / frames / 1024;
      const mbps = (totalBytes * 8) / span / 1e6;
      console.log(`[fps] frames=${frames} span=${span.toFixed(2)}s  => ${fps.toFixed(1)} fps`);
      console.log(`[fps] avg ${kbPerFrame.toFixed(1)} KB/frame  bitrate ${mbps.toFixed(1)} Mbps (JPEG, pre-H264)`);
      await call("Target.closeTarget", { targetId }).catch(() => {});
      ws.close();
      process.exit(0);
    }, DURATION_MS);
  } catch (e) {
    console.error("[fps] error:", e.message);
    if (targetId) await call("Target.closeTarget", { targetId }).catch(() => {});
    ws.close();
    process.exit(1);
  }
});

ws.addEventListener("error", (e) => {
  console.error("[fps] ws error", e.message ?? e);
  process.exit(1);
});
