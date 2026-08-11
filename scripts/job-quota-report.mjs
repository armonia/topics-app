#!/usr/bin/env node
// Rende leggibile la misura di `measure-job-quota.sh`: legge `results.txt`,
// scarta le corse uscite non-zero (una build rotta col cronometro attaccato non
// è un tempo) e stampa un PNG con le mediane per configurazione.
//
// Uso: node scripts/job-quota-report.mjs [results.txt] [out.png]

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "playwright";

const SRC = process.argv[2] || "/tmp/job-quota-measure/results.txt";
const OUT = process.argv[3] || "/tmp/job-quota-measure/report.png";

const righe = readFileSync(SRC, "utf8").trim().split("\n").filter(Boolean).map((r) => {
  const [giro, etichetta, wall, loadPrima, loadDopo, rc] = r.split(/\s+/);
  return { giro: +giro, etichetta, wall: +wall, loadPrima: +loadPrima, loadDopo: +loadDopo, rc: +rc };
});

const buone = righe.filter((r) => r.rc === 0);
const rotte = righe.filter((r) => r.rc !== 0);

const mediana = (v) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
};

const perConfig = new Map();
for (const r of buone) {
  if (!perConfig.has(r.etichetta)) perConfig.set(r.etichetta, []);
  perConfig.get(r.etichetta).push(r);
}

const config = [...perConfig.entries()].map(([etichetta, corse]) => ({
  etichetta,
  corse,
  mediana: mediana(corse.map((c) => c.wall)),
})).sort((a, b) => (a.etichetta === "libera" ? -1 : b.etichetta === "libera" ? 1 : a.etichetta.localeCompare(b.etichetta)));

const libera = config.find((c) => c.etichetta === "libera");
const massimo = Math.max(...config.map((c) => c.mediana), 1);
const loadMin = Math.min(...buone.map((r) => Math.min(r.loadPrima, r.loadDopo)));
const loadMax = Math.max(...buone.map((r) => Math.max(r.loadPrima, r.loadDopo)));

const prezzo = (c) => {
  if (!libera || c.etichetta === "libera") return "—";
  const d = ((c.mediana - libera.mediana) / libera.mediana) * 100;
  return `${d >= 0 ? "+" : ""}${d.toFixed(0)}%`;
};

const barre = config.map((c) => `
  <div class="riga">
    <div class="et">${c.etichetta === "libera" ? "libera <span class='sub'>tutti i core</span>" : `recintata <span class='sub'>-j${c.etichetta.slice(1)}</span>`}</div>
    <div class="barra"><div class="fill ${c.etichetta === "libera" ? "free" : "fenced"}" style="width:${(c.mediana / massimo) * 100}%"></div></div>
    <div class="val">${c.mediana}s <span class="sub">${prezzo(c)}</span></div>
  </div>`).join("");

const tabella = righe.map((r) => `
  <tr class="${r.rc === 0 ? "" : "rotta"}">
    <td>${r.giro}</td><td>${r.etichetta}</td><td class="num">${r.wall}s</td>
    <td class="num sub">${r.loadPrima} → ${r.loadDopo}</td>
    <td class="num">${r.rc === 0 ? "ok" : `rc=${r.rc}`}</td>
  </tr>`).join("");

const html = `<!doctype html><meta charset="utf-8"><style>
  *{box-sizing:border-box} body{margin:0;padding:34px 38px;width:900px;background:#0f1115;color:#e7e9ee;
    font:14px/1.5 ui-sans-serif,-apple-system,"SF Pro Text",Inter,system-ui}
  h1{margin:0 0 4px;font-size:19px;letter-spacing:-.02em}
  .cap{color:#8b93a7;font-size:12.5px;margin-bottom:22px}
  .riga{display:grid;grid-template-columns:190px 1fr 118px;align-items:center;gap:14px;margin-bottom:11px}
  .et{font-size:13.5px} .sub{color:#8b93a7;font-weight:400}
  .barra{height:26px;background:#181b22;border-radius:5px;overflow:hidden}
  .fill{height:100%;border-radius:5px}
  .free{background:linear-gradient(90deg,#3b4252,#59627a)}
  .fenced{background:linear-gradient(90deg,#2f6f4f,#3f9c6d)}
  .val{text-align:right;font-variant-numeric:tabular-nums;font-size:13.5px}
  table{width:100%;border-collapse:collapse;margin-top:24px;font-size:12.5px}
  th{text-align:left;color:#8b93a7;font-weight:500;padding:6px 8px;border-bottom:1px solid #262a33}
  td{padding:5px 8px;border-bottom:1px solid #1a1d24} .num{text-align:right;font-variant-numeric:tabular-nums}
  .rotta{color:#c76b6b}
  .nota{margin-top:20px;padding:12px 14px;background:#151922;border-left:3px solid #3f9c6d;border-radius:4px;
    color:#aab2c4;font-size:12.5px}
</style>
<h1>Il prezzo del recinto — build Tauri da zero, 12 core</h1>
<div class="cap">Corse interlacciate (libera / recintata, a giro) · mediana su ${libera ? libera.corse.length : 0} giri ·
  load di fondo ${loadMin}–${loadMax} · target dir vergine a ogni corsa</div>
${barre}
<table>
  <tr><th>giro</th><th>configurazione</th><th class="num">wall</th><th class="num">load</th><th class="num">esito</th></tr>
  ${tabella}
</table>
<div class="nota"><b>La quota di questa macchina è −j3</b>: 12 core ÷ tetto strutturale 4.
  ${libera && config.length > 1 ? `Il recinto costa ${prezzo(config.find((c) => c.etichetta !== "libera"))} sulla build di UN agente — ed è il prezzo per cui gli altri tre, e l'umano, continuano a esistere.` : ""}
  ${rotte.length ? `<br><b>${rotte.length} corse scartate</b> (uscite non-zero): non sono misure.` : ""}</div>`;

const tmp = "/tmp/job-quota-report.html";
writeFileSync(tmp, html);
mkdirSync(dirname(OUT), { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 200 }, deviceScaleFactor: 2 });
await page.goto("file://" + tmp);
await page.screenshot({ path: OUT, fullPage: true });
await browser.close();
console.log("report:", OUT);
for (const c of config) console.log(`  ${c.etichetta}: mediana ${c.mediana}s ${prezzo(c)} (n=${c.corse.length})`);
if (rotte.length) console.log(`  scartate: ${rotte.length}`);
