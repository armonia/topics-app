/**
 * Playwright WebKit contro Chromium headless, sullo stesso banco.
 *
 * L'attribuzione ha DUE filtri, e servono entrambi:
 *  - pid NUOVO rispetto allo scatto iniziale → esclude Ora e Safari, che usano
 *    gli stessi binari WebKit di sistema ed erano già vivi;
 *  - comando che matcha il browser lanciato → esclude tutto ciò che nasce sulla
 *    macchina mentre il banco gira (il primo giro senza questo filtro dava
 *    1212 MB alla prima pane e 1117 MB di "residuo", cioè rumore puro).
 *
 * Ogni motore viene misurato N volte e si tiene la MEDIANA: una sola passata su
 * una macchina viva non è una misura, è un aneddoto.
 */
import { webkit, chromium } from 'playwright-core';
import { execSync } from 'child_process';
import http from 'http';

const PAT = {
  webkit: /Playwright\.app|com\.apple\.WebKit\.(WebContent|Networking|GPU)/,
  chromium: /chrome-headless-shell|Chromium|Google Chrome for Testing|chrome_crashpad/i,
};

const table = () => execSync('ps -Ao pid,rss,command').toString().trim().split('\n').slice(1)
  .map(l => { const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/); return m && { pid: +m[1], rss: +m[2], cmd: m[3] }; })
  .filter(Boolean);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const mine = (basePids, pat) => Math.round(
  table().filter(p => !basePids.has(p.pid) && pat.test(p.cmd)).reduce((s, p) => s + p.rss, 0) / 1024);

const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<h1>pane</h1>'); }).listen(4614);

async function once(L, pat, n, opts) {
  const basePids = new Set(table().map(p => p.pid));
  const b = await L.launch(opts);
  const marks = [];
  for (let i = 0; i < n; i++) {
    const p = await (await b.newContext()).newPage();
    await p.goto('http://127.0.0.1:4614/', { waitUntil: 'load', timeout: 30000 }).catch(() => {});
    await sleep(900);
    marks.push(mine(basePids, pat));
  }
  await b.close(); await sleep(2500);
  return { marks, leaked: mine(basePids, pat) };
}

const median = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const N = 6, RUNS = 3;
const chromeArgs = { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] };

for (const [name, L, opts] of [['webkit', webkit, { headless: true }], ['chromium', chromium, chromeArgs]]) {
  const runs = [];
  for (let r = 0; r < RUNS; r++) runs.push(await once(L, PAT[name], N, opts));
  const first = median(runs.map(r => r.marks[0]));
  const last = median(runs.map(r => r.marks[N - 1]));
  const slope = median(runs.map(r => (r.marks[N - 1] - r.marks[0]) / (N - 1)));
  const leak = median(runs.map(r => r.leaked));
  console.log(`${name.padEnd(9)} 1a ${String(first).padStart(4)} MB → ${N}: ${String(last).padStart(4)} MB | marginale ${slope.toFixed(0).padStart(3)} MB/pane | residuo ${leak} MB`);
  console.log(`          giri: ${runs.map(r => r.marks.join('/')).join('  ·  ')}`);
}
srv.close();
