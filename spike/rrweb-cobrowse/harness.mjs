// Feasibility gate for rrweb DOM co-browse — the language-agnostic proof (mirrors
// spike/webrtc-cdp/measure-fps.mjs discipline). For each target it:
//   1. injects rrweb into a SOURCE headless page, records the DOM event stream;
//   2. measures bandwidth (full snapshot + steady-state incrementals) and capture latency;
//   3. reconstructs the DOM in a FOLLOWER page via rrweb Replayer (real HTML/CSS, no video);
//   4. screenshots source vs follower and scores similarity (downscaled pixel MAE);
//   5. asserts DOM fidelity incl. that LIVE mutations propagated.
//
// Run:  bun spike/rrweb-cobrowse/harness.mjs
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const DIR = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(DIR, 'shots');
mkdirSync(SHOTS, { recursive: true });
const RECORD_BUNDLE = readFileSync(join(DIR, 'vendor/rrweb.min.js'), 'utf8') + '\n;window.rrweb=rrweb;';
const RECORD_START = readFileSync(join(DIR, 'record-start.js'), 'utf8');
const CLIENT_URL = pathToFileURL(join(DIR, 'client.html')).href;
const FIXTURE_URL = pathToFileURL(join(DIR, 'fixture.html')).href;

const TARGETS = [
  { name: 'fixture', url: FIXTURE_URL, waitMs: 3500, probe: '#counter', expectText: 'rrweb co-browse' },
  { name: 'example.com', url: 'https://example.com', waitMs: 1500, probe: 'h1', expectText: 'Example Domain' },
];

const VP = { width: 1280, height: 800 };

async function similarity(browser, bufA, bufB) {
  const p = await browser.newPage();
  const sim = await p.evaluate(async ([a, b]) => {
    function load(src) { return new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; }); }
    const W = 320, H = 200;
    const ia = await load('data:image/png;base64,' + a);
    const ib = await load('data:image/png;base64,' + b);
    if (!ia || !ib) return 0;
    function px(img) { const c = new OffscreenCanvas(W, H); const x = c.getContext('2d'); x.drawImage(img, 0, 0, W, H); return x.getImageData(0, 0, W, H).data; }
    const da = px(ia), db = px(ib);
    let sum = 0, n = 0;
    for (let i = 0; i < da.length; i += 4) { sum += Math.abs(da[i] - db[i]) + Math.abs(da[i+1] - db[i+1]) + Math.abs(da[i+2] - db[i+2]); n += 3; }
    return 1 - (sum / n) / 255;
  }, [bufA.toString('base64'), bufB.toString('base64')]);
  await p.close();
  return sim;
}

async function runTarget(browser, t) {
  const context = await browser.newContext({ viewport: VP, deviceScaleFactor: 1 });
  const page = await context.newPage();

  const events = [];
  let bytes = 0, fullBytes = 0, sawFull = false, incBytes = 0;
  let latSum = 0, latN = 0, statusOk = false, recErr = null;
  await page.exposeFunction('__rrwebEmit', (json) => {
    const arrived = Date.now();
    let m; try { m = JSON.parse(json); } catch { return; }
    if (m.kind === 'status') { statusOk = true; return; }
    if (m.kind === 'error') { recErr = m.error; return; }
    if (m.kind !== 'event') return;
    const size = json.length;
    bytes += size;
    const e = m.event;
    if (e.type === 2) { sawFull = true; fullBytes += size; }
    else if (sawFull) { incBytes += size; }
    if (typeof m.tPage === 'number') { latSum += Math.max(0, arrived - m.tPage); latN++; }
    events.push(e);
  });
  await page.addInitScript(RECORD_BUNDLE);
  await page.addInitScript(RECORD_START);

  const t0 = Date.now();
  await page.goto(t.url, { waitUntil: 'load', timeout: 20000 }).catch((e) => { recErr = recErr || String(e.message); });
  await page.waitForTimeout(t.waitMs);
  const durationMs = Date.now() - t0;
  const srcShot = await page.screenshot({ clip: { x: 0, y: 0, ...VP } });
  writeFileSync(join(SHOTS, `${t.name}.source.png`), srcShot);

  // ---- reconstruct in a follower via rrweb Replayer ----
  const follower = await context.newPage();
  await follower.setViewportSize(VP);
  await follower.goto(CLIENT_URL, { waitUntil: 'load' });
  await follower.evaluate((evs) => window.__replayAll(evs), events);
  await follower.waitForTimeout(500);
  const probe = await follower.evaluate((sel) => window.__probe(sel), t.probe);
  const folShot = await follower.screenshot({ clip: { x: 0, y: 0, ...VP } });
  writeFileSync(join(SHOTS, `${t.name}.follower.png`), folShot);

  const sim = await similarity(browser, srcShot, folShot);

  // fidelity assertions
  const checks = [];
  checks.push(['recorder started', statusOk && !recErr]);
  checks.push(['got full snapshot', sawFull]);
  checks.push(['follower reconstructed DOM', !!probe && probe.nodeCount > 5]);
  checks.push([`follower shows "${t.expectText}"`, !!probe && probe.bodyText.includes(t.expectText)]);
  checks.push(['screenshot similarity ≥ 0.85', sim >= 0.85]);
  if (t.name === 'fixture') {
    const counter = probe ? parseInt(probe.selText, 10) : NaN;
    checks.push(['LIVE mutation propagated (counter > 0)', Number.isFinite(counter) && counter > 0]);
  }

  await context.close();

  const seconds = durationMs / 1000;
  return {
    name: t.name,
    events: events.length,
    totalKB: +(bytes / 1024).toFixed(1),
    fullSnapKB: +(fullBytes / 1024).toFixed(1),
    incrBandwidthKBs: +((incBytes / 1024) / seconds).toFixed(2),
    avgCaptureLatencyMs: latN ? +(latSum / latN).toFixed(1) : null,
    similarity: +sim.toFixed(3),
    recErr,
    checks,
  };
}

const browser = await chromium.launch({ headless: true });
const results = [];
for (const t of TARGETS) {
  process.stdout.write(`\n▶ ${t.name} … `);
  try { const r = await runTarget(browser, t); results.push(r); process.stdout.write('ok'); }
  catch (e) { process.stdout.write('FAIL ' + e.message); results.push({ name: t.name, fatal: String(e.message), checks: [] }); }
}
await browser.close();

console.log('\n\n=== rrweb co-browse — feasibility gate ===');
for (const r of results) {
  console.log(`\n# ${r.name}`);
  if (r.fatal) { console.log('  FATAL:', r.fatal); continue; }
  console.log(`  events=${r.events}  total=${r.totalKB}KB  fullSnapshot=${r.fullSnapKB}KB  steady=${r.incrBandwidthKBs}KB/s  captureLatency=${r.avgCaptureLatencyMs}ms  similarity=${r.similarity}`);
  if (r.recErr) console.log('  recErr:', r.recErr);
  for (const [label, ok] of r.checks) console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}`);
}

const allChecks = results.flatMap((r) => r.checks || []);
const passed = allChecks.filter(([, ok]) => ok).length;
const total = allChecks.length;
console.log(`\n=== ${passed}/${total} checks passed ===`);
writeFileSync(join(DIR, 'last-run.json'), JSON.stringify(results, null, 2));
process.exit(passed === total && results.every((r) => !r.fatal) ? 0 : 1);
