/**
 * LA BARRA dell'occlusione: un overlay che si apre sopra una pane browser
 * nativa DEVE essere visto dal tracciatore nell'istante in cui si apre.
 *
 * Perché uno script e non un test unitario: la domanda è sul MOTORE. Un modale
 * di questa app entra con un'animazione CSS (`command-palette-enter`), e la
 * `opacity` che `getComputedStyle` restituisce nel momento in cui il
 * MutationObserver misura il pannello appena inserito è ancora `"0"` — misurato
 * in WebKit e in Chromium. Nessun test senza DOM può vedere quel numero, e il
 * progetto non ha jsdom/happy-dom (scelta esplicita, vedi lib/haptics.test.ts).
 * Qui gira `lib/shell/browserOcclusion` VERO, dentro il WebKit di Playwright —
 * lo stesso motore della WKWebView che l'app usa per le pane browser.
 *
 * Esce non-zero se un overlay non viene rilevato. Con `--video <dir>` registra
 * la scena (la clip di consegna); `--headed` la mostra a schermo.
 *
 *   node scripts/check-occlusion.mjs [--video <dir>] [--headed]
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'package.json'));
const { webkit } = require('@playwright/test');

const argv = process.argv.slice(2);
const VIDEO_DIR = argv.includes('--video') ? argv[argv.indexOf('--video') + 1] : null;
const HEADED = argv.includes('--headed');
/** Etichetta scritta nella scena — serve alla clip di consegna, che mostra la
 *  stessa prova su due versioni del codice e deve dire quale sta guardando. */
const LABEL = argv.includes('--label') ? argv[argv.indexOf('--label') + 1] : '';

// ── 1. Il modulo vero, bundlato per il browser ───────────────────────────────
const out = mkdtempSync(join(tmpdir(), 'occl-'));
execFileSync(
  'bun',
  ['build', join(ROOT, 'scripts/occlusion-probe-entry.ts'), '--target=browser', '--outfile', join(out, 'probe.js')],
  { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] },
);
const PROBE = readFileSync(join(out, 'probe.js'), 'utf8');

// ── 2. Il CSS vero dell'entrata dei modali ───────────────────────────────────
// Estratto da index.css, non ricopiato: se un giorno l'animazione cambia (o
// sparisce), questa prova segue il prodotto invece di descrivere il passato.
const CSS_SRC = readFileSync(join(ROOT, 'client/src/index.css'), 'utf8');
const grabRule = (head) => {
  const i = CSS_SRC.indexOf(head);
  if (i < 0) throw new Error(`regola CSS non trovata in index.css: ${head}`);
  const open = CSS_SRC.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < CSS_SRC.length; j++) {
    if (CSS_SRC[j] === '{') depth++;
    else if (CSS_SRC[j] === '}' && --depth === 0) return CSS_SRC.slice(i, j + 1);
  }
  throw new Error(`regola CSS non chiusa: ${head}`);
};
const ENTER_CSS = [grabRule('@keyframes commandPaletteIn'), grabRule('.command-palette-enter')].join('\n');

// ── 3. La scena ──────────────────────────────────────────────────────────────
// Uno slot di pane browser a destra (dove sta la WKWebView) e un modale che si
// apre al centro sopra di lui: la geometria di un ⌘N su un progetto con una
// pane browser aperta.
const SLOT = { x: 640, y: 120, width: 600, height: 620 };
const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  :root { color-scheme: dark }
  body { margin:0; font: 13px -apple-system, system-ui, sans-serif; background:#16181d; color:#e6e8ec; height:100vh }
  #slot { position:fixed; left:${SLOT.x}px; top:${SLOT.y}px; width:${SLOT.width}px; height:${SLOT.height}px;
          background:#0b3d2e; border:1px solid #1f7a5c; border-radius:8px; display:flex; align-items:center; justify-content:center }
  #slot b { font-size:15px; opacity:.85 }
  #verdict { position:fixed; left:24px; top:200px; width:560px; padding:20px 22px; border-radius:10px;
             background:#20232a; border:1px solid #363b45; font-size:15px; line-height:1.7 }
  #verdict .v { font-size:22px; font-weight:600; letter-spacing:.2px }
  #label { position:fixed; left:24px; top:40px; width:560px; font-size:26px; font-weight:600 }
  #label small { display:block; font-size:14px; font-weight:400; opacity:.65; margin-top:6px; line-height:1.5 }
  .bad { color:#ff6b6b } .good { color:#63d69c }
  ${ENTER_CSS}
</style></head><body>
  <div id="label">${LABEL}<small>⌘N apre un modale sopra una pane browser nativa. La webview composita SOPRA il DOM: se il tracciatore non la vede coperta, il modale finisce sotto.</small></div>
  <div id="slot" data-native-browser-slot="pane-1"><b>pane browser nativa (WKWebView)</b></div>
  <div id="verdict"><div class="v">in attesa…</div><div id="detail"></div></div>
<!-- L'observer del tracciatore si arma solo dentro la shell nativa: e' li' che il
     problema esiste. Questa e' la stessa porta da cui l'app riconosce Tauri
     (lib/shell/index.ts), e va aperta PRIMA che il modulo venga valutato:
     shellKind e' una costante di caricamento. -->
<script>window.__TAURI_INTERNALS__ = {};</script>
<script>${PROBE}</script>
<script>
  const SLOT = ${JSON.stringify(SLOT)};
  const occl = window.__occl;
  window.__seen = [];
  window.__lateSeen = null;
  const paint = (frozen, note) => {
    document.querySelector('#verdict .v').className = 'v ' + (frozen ? 'good' : 'bad');
    document.querySelector('#verdict .v').textContent = frozen
      ? 'overlay VISTO → la pane si congela, il modale si vede'
      : 'overlay NON visto → la webview nativa resta SOPRA il modale';
    document.querySelector('#detail').textContent = note;
  };
  occl.onOcclusionChange((rects) => { window.__seen.push(rects.map(r => ({ ...r }))); });
  // Il verdetto si ridipinge da solo, leggendo lo stato invece di aspettare una
  // notifica: è ciò che rende la scena onesta anche quando la notifica NON
  // arriva — che è esattamente il difetto in esame.
  setInterval(() => {
    const rects = occl.currentOverlays();
    const frozen = occl.decideFreeze(SLOT, rects);
    paint(frozen, 'overlay visti dal tracciatore: ' + rects.length + ' · notifiche ricevute: ' + window.__seen.length);
  }, 80);
  window.__openModal = () => {
    const back = document.createElement('div');
    back.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45)';
    const card = document.createElement('div');
    card.className = occl.MODAL_PANEL;
    card.style.cssText = 'position:fixed;left:50%;top:170px;transform:translateX(-50%);width:520px;height:340px;background:#22252c;border:1px solid #3a4049;border-radius:12px;padding:18px';
    card.textContent = 'New… (⌘N)';
    document.body.append(back, card);
  };
  // La pane che si iscrive DOPO: un secondo pannello browser (o lo stesso, che
  // si ri-registra a un re-render) mentre il modale è già aperto.
  window.__subscribeLate = () => new Promise((res) => {
    let got = null;
    occl.onOcclusionChange((rects) => { if (got === null) got = rects.map(r => ({ ...r })); });
    setTimeout(() => { window.__lateSeen = got; res(got); }, 0);
  });
</script></body></html>`;

// ── 4. La misura ─────────────────────────────────────────────────────────────
const browser = await webkit.launch({ headless: !HEADED });
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  ...(VIDEO_DIR ? { recordVideo: { dir: VIDEO_DIR, size: { width: 1280, height: 800 } } } : {}),
});
const page = await context.newPage();
await page.setContent(HTML);
if (!(await page.evaluate(() => typeof window.__occl === 'object' && window.__occl !== null))) {
  throw new Error('il modulo di occlusione non si è caricato nella pagina di prova');
}

const failures = [];
const record = (ok, name, detail) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

const SCENE = HEADED || VIDEO_DIR; // clip di consegna: pause leggibili, non minime
await page.waitForTimeout(SCENE ? 2000 : 100);

// (a) Il caso del difetto: il modale si apre, e va visto SUBITO — prima che
//     l'animazione d'entrata finisca. Al primo giro di misura la sua opacity
//     calcolata è "0", ed è lì che il tracciatore lo perdeva.
await page.evaluate(() => window.__openModal());
await page.waitForTimeout(60);
const early = await page.evaluate(() => {
  const rects = window.__occl.currentOverlays().map((r) => ({ ...r }));
  return { rects, frozen: window.__occl.decideFreeze(window.__SLOT ?? null, rects) };
});
record(
  early.rects.length > 0,
  'il modale è un overlay noto entro 60ms (mentre sta ancora entrando)',
  `${early.rects.length} overlay`,
);

// (b) E deve intersecare la pane: vederlo non basta, la decisione è geometrica.
const decided = await page.evaluate((slot) => window.__occl.decideFreeze(slot, window.__occl.currentOverlays()), SLOT);
record(decided === true, 'la pane sotto il modale decide di congelarsi');

// (c) La pane che si iscrive DOPO deve ricevere subito lo stato corrente: senza,
//     resta cieca finché qualcosa d'altro cambia — e nel frattempo copre il modale.
const late = await page.evaluate(() => window.__subscribeLate());
record(Array.isArray(late) && late.length > 0, 'chi si iscrive a modale già aperto riceve subito gli overlay',
  late === null ? 'nessuna notifica' : `${late.length} overlay`);

// (d) Controllo positivo: a fine animazione l'overlay resta noto (nessun
//     rilevamento «solo durante l'animazione», che sarebbe un caso al contrario).
await page.waitForTimeout(SCENE ? 2500 : 400);
const settled = await page.evaluate((slot) => window.__occl.decideFreeze(slot, window.__occl.currentOverlays()), SLOT);
record(settled === true, 'ad animazione finita la pane è ancora congelata');

// Ciò che la scena DICE, non ciò che il test conclude: è il testo che finisce
// nella clip, e stamparlo qui lo rende verificabile senza guardare i pixel.
console.log(`\nscena: «${await page.textContent('#verdict .v')}» — ${await page.textContent('#detail')}`);
await page.waitForTimeout(SCENE ? 2500 : 0);
await page.close();
await context.close();
await browser.close();

if (VIDEO_DIR) {
  mkdirSync(VIDEO_DIR, { recursive: true });
  const clip = readdirSync(VIDEO_DIR).filter((f) => f.endsWith('.webm')).sort().pop();
  if (clip) {
    const dest = join(VIDEO_DIR, 'occlusione.webm');
    if (join(VIDEO_DIR, clip) !== dest) copyFileSync(join(VIDEO_DIR, clip), dest);
    console.log(`\nclip: ${dest}`);
  }
}

if (failures.length) {
  console.error(`\n${failures.length} controlli falliti — un overlay può finire sotto la webview nativa.`);
  process.exit(1);
}
console.log('\nocclusione: tutti i controlli verdi.');
