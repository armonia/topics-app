// WebKit forced-reflow layout-cost benchmark for the sidebar FLIP.
// Real WebKit (Playwright, same engine as Tauri's WKWebView), headless OFFSCREEN.
// Measures SYNCHRONOUS forced-reflow timing (JS + layout) — does NOT depend on rAF/
// compositor (headless WebKit throttles rAF), so it is reliable AND lock-proof.
const { webkit } = require(require('path').join(__dirname,'..','node_modules','playwright-core'));

const BENCH = () => {
  function build(N, rows, cols) {
    const root = document.createElement('div');
    root.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;font:12px monospace;';
    const main = document.createElement('div');
    main.style.cssText = 'flex:1;display:flex;flex-direction:column;min-height:0;min-width:0;overflow:hidden;contain:layout style;padding-left:0px;';
    const flip = document.createElement('div');
    flip.style.cssText = 'flex:1;display:flex;flex-direction:column;min-height:0;min-width:0;';
    const grid = document.createElement('div');
    grid.style.cssText = 'flex:1;display:flex;flex-direction:row;min-height:0;min-width:0;';
    for (let p = 0; p < N; p++) {
      const cell = document.createElement('div');
      cell.style.cssText = 'flex:1 1 0%;display:flex;flex-direction:column;min-width:0;border:1px solid #333;';
      const term = document.createElement('div'); term.className = 'xterm';
      term.style.cssText = 'flex:1;min-height:0;overflow:hidden;line-height:1.2;';
      const screen = document.createElement('div');
      for (let r = 0; r < rows; r++) {
        const row = document.createElement('div'); row.style.cssText = 'white-space:pre;display:flex;';
        for (let c = 0; c < cols; c++) { const s = document.createElement('span'); s.textContent = String.fromCharCode(65 + ((r + c) % 26)); row.appendChild(s); }
        screen.appendChild(row);
      }
      term.appendChild(screen); cell.appendChild(term); grid.appendChild(cell);
    }
    flip.appendChild(grid); main.appendChild(flip); root.appendChild(main); document.body.appendChild(root);
    return { root, main, flip };
  }
  const med = a => { const b=[...a].sort((x,y)=>x-y); return b[Math.floor(b.length/2)]; };
  const p95 = a => { const b=[...a].sort((x,y)=>x-y); return b[Math.floor(b.length*0.95)]; };
  function measure(main, flip, mode, iters) {
    const t = []; void main.getBoundingClientRect();
    for (let i = 0; i < iters; i++) {
      const pad = 256 - (i % 2) * (i % 12);
      const t0 = performance.now();
      if (mode === 'padding') main.style.paddingLeft = pad + 'px';
      else flip.style.transform = 'translateX(' + (pad - 256) + 'px)';
      void flip.getBoundingClientRect();
      t.push(performance.now() - t0);
    }
    return { median: +med(t).toFixed(3), p95: +p95(t).toFixed(3), max: +Math.max(...t).toFixed(3) };
  }
  const results = {};
  for (const N of [2, 5, 8, 16]) {
    const { root, main, flip } = build(N, 24, 80);
    measure(main, flip, 'padding', 5); measure(main, flip, 'transform', 5);
    const pad = measure(main, flip, 'padding', 40);
    main.style.paddingLeft = '0px'; void main.getBoundingClientRect();
    const tr = measure(main, flip, 'transform', 40);
    results['N=' + N] = { spans: N*24*80, paddingLeft_ms: pad, transform_ms: tr, speedup: Math.round(pad.median / Math.max(tr.median, 0.001)) };
    root.remove();
  }
  return { engine: navigator.userAgent, results };
};

(async () => {
  const browser = await webkit.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1680, height: 1050 }, deviceScaleFactor: 2 });
    console.log(JSON.stringify(await page.evaluate(BENCH), null, 2));
  } finally { await browser.close(); }
})().catch(e => { console.error('ERR', e && e.message); process.exit(1); });
