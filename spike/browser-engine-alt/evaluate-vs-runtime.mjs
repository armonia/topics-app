/**
 * `page.evaluate` E' DAVVERO IL SOSTITUTO DI `Runtime.evaluate`?
 *
 * Il commento di `startRecordingNow` (server/browser-service.ts) motiva il CDP
 * nudo contro `addScriptTag`, che la CSP dei siti veri rifiuta. Ma il candidato
 * portabile non e' addScriptTag: e' `page.evaluate`. Due cose vanno provate
 * prima di dichiararlo equivalente, e nessuna delle due si deduce leggendo:
 *
 *   A. sopravvive a `script-src 'self'` (il bundle deve girare lo stesso);
 *   B. un `var rrweb = ...` al livello top dell'espressione diventa DAVVERO un
 *      globale della pagina. Se Playwright incapsula l'espressione in una
 *      funzione, la var resta locale e `RRWEB_RECORD_START`, che gira in una
 *      seconda chiamata e cerca `window.rrweb`, non trova niente.
 *
 * Si misura su una pagina con CSP severa servita in locale, su webkit e
 * chromium, esattamente nella forma in cui il servizio la usa: due chiamate
 * separate, la seconda che legge cio' che la prima ha definito.
 */
import { webkit, chromium } from 'playwright-core';
import { createServer } from 'node:http';

const HTML = `<!doctype html><meta charset=utf-8><title>csp</title><body>ciao</body>`;
const server = createServer((_req, res) => {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    // La stessa forma che GitHub/Google servono: niente 'unsafe-inline'.
    'content-security-policy': "default-src 'self'; script-src 'self'",
  });
  res.end(HTML);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

// La forma del bundle vero, ridotta all'osso: una var top-level che le
// chiamate successive si aspettano di trovare come globale.
const BUNDLE = `var rrwebFake = { version: "9.9" }; void 0;`;
const START = `(function(){ return typeof rrwebFake === "undefined" ? "NO-GLOBAL" : rrwebFake.version; })()`;

async function probe(name, launcher) {
  const browser = await launcher.launch({ headless: true });
  const out = { engine: name };
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'load' });

    // 1. addScriptTag: ci si aspetta che la CSP lo rifiuti (e' la ragione per
    //    cui il codice di oggi non lo usa — qui si conferma che il motivo vive).
    try {
      await page.addScriptTag({ content: BUNDLE });
      out.addScriptTag = await page.evaluate(START).catch(() => 'eval-failed');
    } catch (err) {
      out.addScriptTag = `REFUSED: ${String(err.message).split('\n')[0].slice(0, 60)}`;
    }

    // 2. page.evaluate in due chiamate separate, come fa startRecordingNow.
    const page2 = await ctx.newPage();
    await page2.goto(url, { waitUntil: 'load' });
    try {
      await page2.evaluate(BUNDLE);
      out.pageEvaluate = await page2.evaluate(START);
    } catch (err) {
      out.pageEvaluate = `THREW: ${String(err.message).split('\n')[0].slice(0, 80)}`;
    }

    // 3. Il CDP nudo di oggi, per confronto (solo chromium).
    const page3 = await ctx.newPage();
    await page3.goto(url, { waitUntil: 'load' });
    try {
      const cdp = await ctx.newCDPSession(page3);
      await cdp.send('Runtime.evaluate', { expression: BUNDLE, returnByValue: false, awaitPromise: false });
      const res = await cdp.send('Runtime.evaluate', { expression: START, returnByValue: true, awaitPromise: false });
      out.runtimeEvaluate = res.result?.value ?? JSON.stringify(res.result);
      await cdp.detach().catch(() => {});
    } catch (err) {
      out.runtimeEvaluate = `THREW: ${String(err.message).split('\n')[0].slice(0, 60)}`;
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return out;
}

const rows = [];
rows.push(await probe('chromium', chromium));
rows.push(await probe('webkit', webkit));
server.close();
for (const r of rows) console.log(JSON.stringify(r, null, 2));
