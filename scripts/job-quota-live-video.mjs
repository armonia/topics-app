#!/usr/bin/env node
// Il video della corsa di `job-quota-live-demo.ts`: le righe sono quelle che ha
// stampato davvero, con il loro tempo vero nella colonna di sinistra. Il ritmo
// con cui compaiono è invece scelto per essere leggibile (la corsa vera dura un
// secondo): il tempo è il dato, la cadenza è l'impaginazione, e la riga in
// fondo lo dice invece di lasciarlo intendere.
//
// Uso: node scripts/job-quota-live-video.mjs [log.json] [out.webm]

import { readFileSync, mkdirSync, renameSync, rmSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { chromium } from "playwright";

const SRC = process.argv[2] || "/tmp/job-quota-live/log.json";
const OUT = process.argv[3] || "/tmp/job-quota-live/quota-viva.webm";
const { cores, congelato, righe } = JSON.parse(readFileSync(SRC, "utf8"));

const COLORI = {
  info: "#8b96a8",
  atto: "#7fd2ff",
  misura: "#ffc857",
  ok: "#5ddc9a",
  ko: "#ff6b6b",
};

const html = `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#0d1117;}
  body{font:15px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;color:#c9d1d9;padding:26px 30px;box-sizing:border-box;}
  h1{font-size:15px;margin:0 0 4px;color:#e6edf3;font-weight:600;}
  .sub{color:#8b96a8;margin:0 0 18px;font-size:13px;}
  .r{display:flex;gap:14px;white-space:pre-wrap;opacity:0;transform:translateY(3px);transition:opacity .18s,transform .18s;}
  .r.on{opacity:1;transform:none;}
  .t{color:#4d566a;flex:0 0 76px;text-align:right;}
  .foot{position:fixed;left:30px;bottom:16px;color:#4d566a;font-size:12px;}
</style>
<h1>Quota di core: rilettura a metà sessione</h1>
<p class="sub">${cores} core · l'ambiente del processo resta CARGO_BUILD_JOBS=${congelato} per tutta la scena</p>
<div id="log"></div>
<div class="foot">corsa reale di <b>scripts/job-quota-live-demo.ts</b> — tempi veri a sinistra, cadenza rallentata per la lettura</div>`;

const dirVideo = "/tmp/job-quota-live/rec";
rmSync(dirVideo, { recursive: true, force: true });
mkdirSync(dirVideo, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1000, height: 620 },
  recordVideo: { dir: dirVideo, size: { width: 1000, height: 620 } },
});
const page = await ctx.newPage();
await page.setContent(html);
await page.waitForTimeout(1200);

for (const r of righe) {
  await page.evaluate(
    ([ms, testo, colore]) => {
      const d = document.createElement("div");
      d.className = "r";
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = `${ms}ms`;
      const c = document.createElement("span");
      c.style.color = colore;
      c.textContent = testo;
      d.append(t, c);
      document.getElementById("log").appendChild(d);
      requestAnimationFrame(() => d.classList.add("on"));
    },
    [r.ms, r.testo, COLORI[r.tipo] || COLORI.info],
  );
  await page.waitForTimeout(r.tipo === "misura" ? 1500 : 800);
}
await page.waitForTimeout(2500);

const video = page.video();
await ctx.close();
await browser.close();

mkdirSync(dirname(OUT), { recursive: true });
const prodotto = video ? await video.path() : join(dirVideo, readdirSync(dirVideo)[0]);
renameSync(prodotto, OUT);
console.log(OUT);
