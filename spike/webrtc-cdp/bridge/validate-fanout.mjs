#!/usr/bin/env bun
// Stage 3 proof — SHARED SESSION fan-out: N WebRTC viewers on ONE bridge decode the
// SAME source track simultaneously. This is the Mac+mobile essence: one server-side
// browser session, many viewers, one CDP screencast → one encoder → one shared track.
//
// PASS iff EVERY viewer reaches framesDecoded>15 && videoWidth>0 at the same time.
//
// Usage: bun validate-fanout.mjs [bridgeUrl] [viewers]

import { chromium } from "playwright";

const url = process.argv[2] ?? "http://127.0.0.1:19444/";
const N = Number(process.argv[3] ?? 2);

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

// Independent browser contexts = independent PeerConnections against the same bridge.
const pages = [];
for (let i = 0; i < N; i++) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const tag = `viewer${i + 1}`;
  page.on("console", (m) => console.log(`[${tag}]`, m.text()));
  pages.push({ tag, page });
}

// Load all viewers concurrently (they negotiate independently via POST /offer).
await Promise.all(pages.map((p) => p.page.goto(url, { waitUntil: "load" })));

async function stats(page) {
  return page.evaluate(async () => {
    const v = document.getElementById("v");
    const pc = window.__pc;
    const out = { ice: pc?.iceConnectionState, videoWidth: v?.videoWidth ?? 0, framesDecoded: 0, codec: null };
    if (pc) {
      const rep = await pc.getStats();
      rep.forEach((r) => {
        if (r.type === "inbound-rtp" && r.kind === "video") out.framesDecoded = r.framesDecoded ?? 0;
        if (r.type === "codec" && r.mimeType) out.codec = r.mimeType;
      });
    }
    return out;
  });
}

let all = [];
for (let t = 0; t < 15; t++) {
  await new Promise((r) => setTimeout(r, 1000));
  all = await Promise.all(pages.map((p) => stats(p.page)));
  const line = all
    .map((s, i) => `${pages[i].tag}:ice=${s.ice} ${s.videoWidth}px fd=${s.framesDecoded} ${s.codec ?? "-"}`)
    .join("  |  ");
  console.log(`[t+${t + 1}s] ${line}`);
  if (all.every((s) => s.framesDecoded > 15 && s.videoWidth > 0)) break;
}

await browser.close();

const ok = all.length === N && all.every((s) => s.framesDecoded > 15 && s.videoWidth > 0);
console.log(
  ok
    ? `\n✅ PASS — ${N} viewer decodificano SIMULTANEAMENTE la stessa sessione (fan-out N-peer)`
    : `\n❌ FAIL — non tutti i ${N} viewer hanno decodificato frame`,
);
process.exit(ok ? 0 : 1);
