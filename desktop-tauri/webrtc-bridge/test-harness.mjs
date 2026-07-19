#!/usr/bin/env bun
// Standalone verification of the production webrtc-bridge: reproduces the SERVER's
// relay role (CDP creates a real target → NDJSON offer/answer over the Unix socket →
// browser viewer) without needing the whole app. Proves: attach-to-existing-target,
// shared track fan-out to N viewers, and the NDJSON protocol.
//
// Usage: bun test-harness.mjs [viewers]   (needs Chromium CDP on :19222)

import { chromium } from "playwright";

const N = Number(process.argv[2] ?? 2);
const BIN = new URL("./target/release/webrtc-bridge", import.meta.url).pathname;
const SOCK = "/tmp/topics-webrtc-test.sock";
const HTTP_PORT = 19555;

const VIEWER_HTML = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<style>html,body{margin:0;background:#000;height:100%}#v{width:100vw;height:100vh;object-fit:contain}</style>
<video id=v autoplay playsinline muted></video><script>
(async()=>{const pc=new RTCPeerConnection();window.__pc=pc;
pc.addTransceiver('video',{direction:'recvonly'});
pc.ontrack=e=>document.getElementById('v').srcObject=e.streams[0];
const off=await pc.createOffer();await pc.setLocalDescription(off);
await new Promise(r=>{if(pc.iceGatheringState==='complete')return r();pc.onicegatheringstatechange=()=>pc.iceGatheringState==='complete'&&r();});
const a=await(await fetch('/offer',{method:'POST',headers:{'content-type':'application/sdp'},body:pc.localDescription.sdp})).text();
await pc.setRemoteDescription({type:'answer',sdp:a});})();
</script>`;

// ---- 1. Create a real CDP target (animated page = continuous frames) ------------
const ver = await (await fetch("http://127.0.0.1:19222/json/version")).json();
const bws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r, j) => { bws.onopen = r; bws.onerror = j; });
let cdpId = 1;
const cdpPending = new Map();
bws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && cdpPending.has(m.id)) { cdpPending.get(m.id)(m.result); cdpPending.delete(m.id); }
};
const cdp = (method, params = {}) =>
  new Promise((res) => { const i = cdpId++; cdpPending.set(i, res); bws.send(JSON.stringify({ id: i, method, params })); });

const animated =
  "data:text/html," +
  encodeURIComponent(
    `<style>body{margin:0;background:#0b0f1a;font-family:system-ui;overflow:hidden}
h1{color:#7aa2f7;position:absolute;top:24px;left:24px}
.b{position:absolute;width:120px;height:120px;border-radius:50%;background:hsl(0,80%,60%);
animation:m 1.4s ease-in-out infinite alternate,h 3s linear infinite}
@keyframes m{from{left:40px;top:200px}to{left:900px;top:500px}}@keyframes h{to{filter:hue-rotate(360deg)}}</style>
<h1>Topics · shared session (prod bridge)</h1><div class=b></div>`,
  );
const staticPage = "data:text/html," + encodeURIComponent(`<body style="margin:0;background:#123;color:#fff;font:40px system-ui"><h1>STATIC PAGE — no animation</h1>`);
const { targetId } = await cdp("Target.createTarget", { url: process.env.TOPICS_TEST_STATIC ? staticPage : animated });
console.log("[harness] created target", targetId);

// ---- 2. Spawn the bridge, wait for its socket -----------------------------------
try { await Bun.file(SOCK).unlink(); } catch {}
const proc = Bun.spawn([BIN, "--socket", SOCK], { stderr: "inherit", stdout: "inherit" });
for (let i = 0; i < 30 && !(await Bun.file(SOCK).exists()); i++) await Bun.sleep(100);

// ---- 3. Connect to the bridge socket (NDJSON), like the server does -------------
const answerWaiters = new Map(); // peer → resolve(answerSdp)
const sock = await Bun.connect({
  unix: SOCK,
  socket: {
    data(_s, chunk) {
      for (const line of new TextDecoder().decode(chunk).split("\n")) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.t === "ready") console.log("[harness] bridge ready");
        if (msg.t === "answer" && answerWaiters.has(msg.peer)) { answerWaiters.get(msg.peer)(msg.sdp); answerWaiters.delete(msg.peer); }
        if (msg.t === "error") console.error("[harness] bridge error", msg);
      }
    },
  },
});
const sendToBridge = (o) => sock.write(JSON.stringify(o) + "\n");

// ---- 4. Tiny HTTP relay: browser POSTs offer → bridge → answer ------------------
Bun.serve({
  port: HTTP_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") return new Response(VIEWER_HTML, { headers: { "content-type": "text/html" } });
    if (url.pathname === "/offer" && req.method === "POST") {
      const offer = await req.text();
      const peer = crypto.randomUUID();
      const answer = await new Promise((res) => { answerWaiters.set(peer, res); sendToBridge({ t: "offer", peer, target: targetId, sdp: offer }); });
      return new Response(answer, { headers: { "content-type": "application/sdp" } });
    }
    return new Response("not found", { status: 404 });
  },
});

// ---- 5. N Playwright viewers, assert ALL decode simultaneously ------------------
// By default the viewer offers raw 127.0.0.1/LAN host candidates (reliable on
// localhost). Set TOPICS_TEST_MDNS=1 to keep Chrome's `.local` mDNS obfuscation and
// exercise the bridge's own mDNS resolution (the real mobile-client path).
const viewerArgs = ["--no-sandbox", "--disable-dev-shm-usage"];
let headless = true;
if (process.env.TOPICS_TEST_MDNS) {
  // Exercise the real mDNS path. new-headless (unlike headless-shell) runs Chrome's
  // mDNS responder so `.local` candidates can be resolved by the bridge.
  viewerArgs.push("--headless=new");
  headless = false;
} else {
  viewerArgs.push("--disable-features=WebRtcHideLocalIpsWithMdns");
}
const browser = await chromium.launch({ headless, args: viewerArgs });
const pages = [];
for (let i = 0; i < N; i++) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${HTTP_PORT}/`, { waitUntil: "load" });
  pages.push({ tag: `viewer${i + 1}`, page });
}
const stats = (page) =>
  page.evaluate(async () => {
    const v = document.getElementById("v"), pc = window.__pc;
    const o = { ice: pc?.iceConnectionState, videoWidth: v?.videoWidth ?? 0, framesDecoded: 0, codec: null };
    if (pc) (await pc.getStats()).forEach((r) => {
      if (r.type === "inbound-rtp" && r.kind === "video") o.framesDecoded = r.framesDecoded ?? 0;
      if (r.type === "codec" && r.mimeType) o.codec = r.mimeType;
    });
    return o;
  });

let all = [];
for (let t = 0; t < 15; t++) {
  await Bun.sleep(1000);
  all = await Promise.all(pages.map((p) => stats(p.page)));
  console.log(`[t+${t + 1}s] ` + all.map((s, i) => `${pages[i].tag}:ice=${s.ice} ${s.videoWidth}px fd=${s.framesDecoded} ${s.codec ?? "-"}`).join("  |  "));
  if (all.every((s) => s.framesDecoded > 15 && s.videoWidth > 0)) break;
}

await browser.close();
proc.kill();
try { await cdp("Target.closeTarget", { targetId }); } catch {}
bws.close();

const ok = all.length === N && all.every((s) => s.framesDecoded > 15 && s.videoWidth > 0);
console.log(ok ? `\n✅ PASS — prod bridge: ${N} viewer decodificano la stessa sessione (attach-to-target + fan-out)` : `\n❌ FAIL`);
process.exit(ok ? 0 : 1);
