// Sonda: il microfono finto di Chromium suona davvero il WAV che gli passo?
// Registra 5 s con MediaRecorder e scrive il blob su disco, così ffmpeg/whisper
// possono dire in chiaro cosa è stato catturato. Non è un test: è il banco.
//
//   node scripts/probe-fake-mic.mjs <out.webm> [file.wav|beep] [secondi]
import { chromium } from "@playwright/test";
import { writeFileSync } from "fs";
import { resolve } from "path";

const out = process.argv[2] || "/tmp/fake-mic-capture.webm";
const which = process.argv[3] || "tests/e2e/fixtures/audio/spoken-phrase.wav";
const seconds = Number(process.argv[4] || 5);

const args = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"];
if (which !== "beep") args.push(`--use-file-for-fake-audio-capture=${resolve(process.cwd(), which)}`);

const browser = await chromium.launch({ args });
const ctx = await browser.newContext({ permissions: ["microphone"] });
const page = await ctx.newPage();
// `about:blank` non è un contesto sicuro: senza origine `localhost`,
// `navigator.mediaDevices` non esiste proprio.
await page.route("**/*", (route) =>
  route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>probe</body></html>" }),
);
await page.goto("http://localhost/probe");

const res = await page.evaluate(async (ms) => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const track = stream.getAudioTracks()[0];
  const label = track.label;

  // Energia misurata sul grafo audio VIVO: dice se il segnale c'è, senza
  // dipendere dal codec né dal file scritto dopo.
  const acx = new AudioContext();
  const analyser = acx.createAnalyser();
  acx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  let peak = 0;

  const rec = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.start(100);
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    analyser.getFloatTimeDomainData(buf);
    for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => { rec.onstop = r; rec.stop(); });

  const blob = new Blob(chunks, { type: "audio/webm" });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return { b64: btoa(s), peak, label, settings: track.getSettings() };
}, seconds * 1000);

writeFileSync(out, Buffer.from(res.b64, "base64"));
console.log(`track="${res.label}" peak=${res.peak.toFixed(4)} settings=${JSON.stringify(res.settings)}`);
console.log(`captured ${Buffer.from(res.b64, "base64").length} bytes → ${out}`);
await browser.close();
