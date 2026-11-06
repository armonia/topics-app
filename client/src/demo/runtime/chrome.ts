/* The page-level dressing every demo scenario shares: the dark frosted window,
 * the terminal webfont and a silenced service worker. None of it is scenario
 * data, so it lives here once instead of in each scenario. */

/* The PWA service worker is pointless inside the demo iframe, and its absolute
 * /sw.js path 404s on the landing origin (console noise). Neuter registration
 * with a forever-pending promise: no fetch, no catch-warn. */
function silenceServiceWorker(): void {
  try {
    if (navigator.serviceWorker && navigator.serviceWorker.register) {
      navigator.serviceWorker.register = () => new Promise<ServiceWorkerRegistration>(() => {});
    }
  } catch (_e) { /* never block boot */ }
}

/* Vibrancy emulation.
 * The real app is a desktop window with native macOS vibrancy: html/body/#root
 * are TRANSPARENT and the chrome (sidebar, tab bars, pane gutters) is a single
 * translucent frosted layer over the blurred desktop. In a plain browser there
 * is no native vibrancy, so the same components fall back to a flat opaque
 * slate and look dead. We recreate the effect WITHOUT touching app code:
 *   (a) add `.native-frost` + `.electron-mac`, which reuses the exact real
 *       vibrancy CSS (index.css, Native frosted backdrop). BOTH classes,
 *       because the real mac shell carries both and the rules are split
 *       between them: `native-frost` holds every translucency rule,
 *       `electron-mac` keeps the 12px #root window corner.
 *   (b) paint a deep, cool aurora backdrop BEHIND the now-transparent root
 *       (body::before, fixed, z-index:-1) so the glass has something living
 *       to frost over: the browser-side stand-in for the blurred desktop. */
function injectVibrancy(): void {
  document.documentElement.classList.add("native-frost");
  document.documentElement.classList.add("electron-mac");
  const css =
    "html.native-frost, html.native-frost body { background: transparent !important; }" +
    /* deep cool base + three soft, blurred glows: a frosted dark desktop */
    "body::before{content:'';position:fixed;inset:0;z-index:-2;pointer-events:none;" +
      "background:" +
        "radial-gradient(900px circle at 14% 4%, hsl(222 92% 58% / .30), transparent 56%)," +
        "radial-gradient(820px circle at 90% 0%, hsl(258 88% 66% / .26), transparent 55%)," +
        "radial-gradient(1100px circle at 62% 112%, hsl(187 86% 54% / .18), transparent 60%)," +
        "linear-gradient(180deg, #0a0e1a 0%, #06090f 58%, #04060b 100%);}" +
    /* A second, softer glow layer so the dark glass chrome picks up cool light.
     * STATIC on purpose: animating a viewport-sized 48px-blurred layer
     * re-rasterizes every frame and tanked the renderer to ~12fps. */
    "body::after{content:'';position:fixed;inset:-20vh -10vw;z-index:-1;pointer-events:none;" +
      "background:radial-gradient(46vw 46vw at 28% 14%, hsl(225 96% 62% / .20), transparent 62%)," +
                 "radial-gradient(42vw 42vw at 80% 82%, hsl(265 92% 68% / .16), transparent 64%);" +
      "filter:blur(48px);}";
  const s = document.createElement("style");
  s.id = "landing-vibrancy";
  s.textContent = css;
  (document.head || document.documentElement).appendChild(s);
  /* Menus and popovers get a SOLID fill here. `.native-frost` makes them 72%
   * translucent over a `backdrop-filter` that only has something to work on
   * under the native window vibrancy; in a plain browser the blur does not
   * reach the panes behind, so the terminal/browser seam showed through the
   * menu. `!important` and not a specificity trick: this runs BEFORE the
   * bundle's stylesheet is linked, so a rule of equal weight loses on source
   * order. Gate: scripts/demo-glass-probe.mjs (check:demo, Chromium and WebKit). */
  const g = document.createElement("style");
  g.id = "landing-glass-solid";
  g.textContent =
    "html.native-frost .glass-surface," +
    "html.native-frost [data-sheet-open]{" +
      "background-color:var(--popover-bg) !important;" +
      "-webkit-backdrop-filter:none !important;backdrop-filter:none !important;}";
  (document.head || document.documentElement).appendChild(g);
}

/* The xterm panes ask for 'JetBrains Mono' first (terminalFont.ts). Without the
 * face the browser falls back to Menlo, whose block glyphs (the Claude Code
 * logo) do not tile against xterm's cell metrics. Load it, then nudge a resize
 * once it is ready so FitAddon re-measures the cell to the real font. */
function loadTerminalFont(): void {
  try {
    const pre1 = document.createElement("link"); pre1.rel = "preconnect"; pre1.href = "https://fonts.googleapis.com";
    const pre2 = document.createElement("link"); pre2.rel = "preconnect"; pre2.href = "https://fonts.gstatic.com"; pre2.crossOrigin = "anonymous";
    const fl = document.createElement("link"); fl.rel = "stylesheet";
    fl.href = "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap";
    (document.head || document.documentElement).append(pre1, pre2, fl);
    if (document.fonts && document.fonts.ready) {
      document.fonts.load("14px 'JetBrains Mono'").then(() => document.fonts.ready).then(() => {
        // re-fit every mounted terminal to the now-loaded font metrics
        window.dispatchEvent(new Event("resize"));
        setTimeout(() => { window.dispatchEvent(new Event("resize")); }, 300);
      }).catch(() => {});
    }
  } catch (_e) { /* the font is a nicety: never block boot */ }
}

/** The dark theme class, then the page dressing, in the order the original shim ran them. */
export function dressDarkWindow(): void {
  document.documentElement.classList.add("dark");
  silenceServiceWorker();
  injectVibrancy();
  loadTerminalFont();
}
