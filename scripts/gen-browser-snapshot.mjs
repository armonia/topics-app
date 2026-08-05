/**
 * Record the rrweb events the landing demo replays in its Browser pane.
 *
 * Why this exists: the demo used to ship a 133 KB base64 JPEG for that pane,
 * and the app moved on. `useRemoteBrowser` now treats an incoming `frame` as a
 * bootstrap SIGNAL and never renders it ("the JPEG frame is an internal
 * bootstrap signal, never rendered"), painting instead from either a WebRTC
 * video track or a stream of rrweb `dom_event`s. Neither exists in a demo with
 * no backend, so the Browser chapter sat on "Avvio sessione condivisa…"
 * forever, showing nothing.
 *
 * rrweb events are the honest path: they are what the real product sends over
 * that socket. This records a Meta + FullSnapshot of `browser-page.html` and
 * writes them next to it, where the landing build inlines them into the demo
 * shim.
 *
 *   node scripts/gen-browser-snapshot.mjs
 */
import pw from '../node_modules/playwright-core/index.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const { chromium } = pw;
const here = dirname(fileURLToPath(import.meta.url));
const PAGE = resolve(here, '../client/src/demo/browser-page.html');
const RECORD = resolve(here, '../client/node_modules/rrweb/dist/record/rrweb-record.min.js');
const OUT = resolve(here, '../client/src/demo/browser-dom-snapshot.json');

// The pane replays into an iframe sized like a browser viewport; record at the
// same shape so the snapshot's layout matches what the demo shows.
const VIEWPORT = { width: 1280, height: 860 };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: VIEWPORT });
await page.goto('file://' + PAGE, { waitUntil: 'load' });

await page.addScriptTag({ path: RECORD });
const events = await page.evaluate(async () => {
  const out = [];
  // `rrwebRecord` è un globale DELLA PAGINA, piantato lì da `addScriptTag` due
  // righe sopra. Questo corpo non gira in Node: `page.evaluate` lo serializza e
  // lo esegue dentro il browser, dove il globale esiste. Il lint vede solo lo
  // scope di Node e non può saperlo.
  // eslint-disable-next-line no-undef
  const stop = rrwebRecord({ emit: (e) => out.push(e) });
  await new Promise((r) => setTimeout(r, 600));
  if (typeof stop === 'function') stop();
  return out;
});
await browser.close();

// Keep only what paints: Meta (4) establishes the viewport, FullSnapshot (2) is
// the document. Incremental events after that are mouse noise from recording.
const keep = events.filter((e) => e.type === 4 || e.type === 2);
const meta = keep.find((e) => e.type === 4);
const snap = keep.find((e) => e.type === 2);
if (!meta || !snap) {
  console.error('No Meta/FullSnapshot captured — the replayer would paint nothing.');
  process.exit(1);
}

writeFileSync(OUT, JSON.stringify([meta, snap]));
const bytes = readFileSync(OUT).length;
console.log(`wrote ${OUT}`);
console.log(`  Meta viewport ${meta.data.width}x${meta.data.height}, FullSnapshot ok, ${(bytes / 1024).toFixed(1)} KB`);
