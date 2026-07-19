#!/usr/bin/env bun
// Headless WebRTC viewer that validates the bridge end-to-end: loads the bridge's
// test page (which negotiates via /offer), then reads getStats to confirm real
// H.264 frames are decoding (inbound-rtp.framesDecoded climbing + video.videoWidth).
//
// Usage: bun validate.mjs [bridgeUrl]

import { chromium } from "playwright";

const url = process.argv[2] ?? "http://127.0.0.1:19444/";
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
page.on("console", (m) => console.log("[page]", m.text()));

await page.goto(url, { waitUntil: "load" });

async function stats() {
  return page.evaluate(async () => {
    const v = document.getElementById("v");
    const pc = window.__pc;
    const out = {
      status: document.getElementById("s")?.textContent,
      ice: pc?.iceConnectionState,
      videoWidth: v?.videoWidth ?? 0,
      videoHeight: v?.videoHeight ?? 0,
      framesDecoded: 0,
      bytesReceived: 0,
      codec: null,
    };
    if (pc) {
      const rep = await pc.getStats();
      rep.forEach((r) => {
        if (r.type === "inbound-rtp" && r.kind === "video") {
          out.framesDecoded = r.framesDecoded ?? 0;
          out.bytesReceived = r.bytesReceived ?? 0;
        }
        if (r.type === "codec" && r.mimeType) out.codec = r.mimeType;
      });
    }
    return out;
  });
}

let last = null;
for (let i = 0; i < 12; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  last = await stats();
  console.log(
    `[t+${i + 1}s] ice=${last.ice} status="${last.status}" video=${last.videoWidth}x${last.videoHeight} ` +
      `framesDecoded=${last.framesDecoded} bytes=${last.bytesReceived} codec=${last.codec}`,
  );
  if (last.framesDecoded > 15 && last.videoWidth > 0) break;
}

await browser.close();

const ok = last && last.framesDecoded > 15 && last.videoWidth > 0;
console.log(ok ? "\n✅ PASS — H.264 WebRTC frames decoding end-to-end" : "\n❌ FAIL — no decoded frames");
process.exit(ok ? 0 : 1);
