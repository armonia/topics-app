// Pre-paint boot script — externalized from index.html so a strict
// `script-src 'self'` CSP (Tauri shell) does NOT block it. Inline <script>
// blocks would be refused under that policy (Tauri injects its own nonce, which
// per CSP3 drops 'unsafe-inline'); a same-origin /boot.js is covered by 'self'
// on every shell (Tauri / Electron / web / PWA). Keep it dependency-free and
// synchronous: it MUST run before first paint to prevent theme FOUC.

(function () {
  // ---- Theme + sidebar state BEFORE first paint (no FOUC/flicker) ----
  var theme = 'system';
  try {
    var raw = localStorage.getItem('theme');
    if (raw) { try { theme = JSON.parse(raw); } catch (e2) { theme = raw; } }
  } catch (e) {}
  var dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) document.documentElement.classList.add('dark');

  // Tinta della barra di sistema (Android/Chrome) in lock-step col tema
  // risolto: quella fascia è il BORDO dell'app e deve leggersi come la sidebar,
  // quindi il colore è il CHROME, non la pagina.
  //
  // Il valore si LEGGE da `--chrome-bg`, non si ricopia. Qui c'erano due hex
  // scritti a mano — la quarta e quinta copia dello stesso colore — e restavano
  // allineati solo per disciplina: `syncThemeColorMeta` in `useTheme.ts` aveva
  // già smesso di copiarli proprio per questo.
  //
  // Non può essere sincrono, e il motivo è l'ordine dell'`<head>`: questo file
  // è uno <script> classico che il parser esegue PRIMA di incontrare il
  // <link rel=stylesheet>, quindi al momento in cui gira nessun token esiste
  // ancora. Si riprova a ogni frame finché il foglio non è in piedi (di solito
  // il primo), più una rete su DOMContentLoaded. Fino ad allora vale il
  // `content` statico di index.html, e la parola definitiva ce l'ha comunque
  // `syncThemeColorMeta` al montaggio di React. Sotto la shell desktop il
  // token porta l'alpha della vibrancy: un `hsl(… / .5)` non è un colore
  // valido per theme-color, quindi lo si lascia stare (stessa guardia del
  // gemello in useTheme.ts).
  // Torna true quando non c'è più niente da fare — scritto, oppure non c'è
  // nessuna meta da scrivere; false solo se il token non è ancora leggibile.
  var scriviThemeColor = function () {
    try {
      var tc = document.querySelector('meta[name="theme-color"]');
      if (!tc) return true;
      var v = getComputedStyle(document.documentElement).getPropertyValue('--chrome-bg').trim();
      if (!v || v.indexOf('/') !== -1) return false;
      tc.setAttribute('content', v);
      return true;
    } catch (e) { return true; }
  };
  if (!scriviThemeColor()) {
    var tentativi = 0;
    var riprova = function () {
      if (scriviThemeColor() || ++tentativi > 20) return;
      requestAnimationFrame(riprova);
    };
    requestAnimationFrame(riprova);
    document.addEventListener('DOMContentLoaded', function () { scriviThemeColor(); });
  }

  // Desktop shell: tag <html> so the page stops painting opaque over the NATIVE
  // frosted backdrop behind the webview. Set before first paint, or the opaque
  // base masks the blur for a frame.
  //
  // `.native-frost` is the shell-neutral hook and carries all the translucency
  // (see index.css); the per-OS classes gate only what is OS-specific:
  //   macOS   `.electron-mac` (legacy name, referenced in CSS) + `.tauri-mac`,
  //           backed by per-region NSVisualEffectViews (vibrancy_set_regions,
  //           driven from useFloatingVibrancy) so the gaps between cards are
  //           truly transparent.
  //   Windows `.windows-acrylic`, backed by ONE whole-window DWM Acrylic
  //           backdrop. DWM has no per-region equivalent, so the gaps are
  //           frosted rather than see-through, and the per-region IPC is never
  //           called there.
  try {
    // navigator.platform is deprecated and can be empty in a WKWebView — OR it
    // with the userAgent (always contains "Mac OS X").
    var __isMac = /Mac/i.test(navigator.platform || '') || /Mac OS X/i.test(navigator.userAgent || '');
    // Windows: the userAgent carries "Windows NT" on WebView2 (and everywhere
    // else). Same OR-with-platform defence as the mac branch.
    var __isWin = /Win/i.test(navigator.platform || '') || /Windows NT/i.test(navigator.userAgent || '');
    // __TAURI_INTERNALS__ is injected at document-start but not guaranteed before
    // this synchronous script — ALSO key on the custom origin (tauri://localhost),
    // available synchronously. Either signal is enough.
    var __isTauri = !!(window.__TAURI_INTERNALS__ || window.__TAURI__)
      || location.protocol === 'tauri:'
      || /(^|\.)tauri\.localhost$/i.test(location.hostname || '');
    if (__isTauri && __isMac) {
      document.documentElement.classList.add('electron-mac');
      document.documentElement.classList.add('tauri-mac');
      document.documentElement.classList.add('native-frost');
    } else if (__isTauri && __isWin) {
      document.documentElement.classList.add('windows-acrylic');
      document.documentElement.classList.add('native-frost');
    }
  } catch (e) {}

  // Pre-apply sidebar collapsed state
  try {
    var settings = JSON.parse(localStorage.getItem('app-settings') || '{}');
    if (settings.sidebarCollapsed) document.documentElement.classList.add('sidebar-pre-collapsed');
  } catch (e) {}
})();

// ---- Service Worker (PWA) — only on localhost or cloudflare tunnels ----
// NEVER under the desktop shell: it serves the UI from tauri://localhost (hostname
// is literally `localhost`), so an SW would precache the app shell and then serve
// that STALE shell on every launch — bypassing embedded/disk-serve and pinning the
// window to an old bundle (the "still on 2.1.57" bug). The shell has its own asset
// pipeline (embedded or hot-reload disk-serve), so a PWA cache is pure harm here.
// Under Tauri we fall into the else-branch below → any previously-registered SW is
// unregistered, self-healing an app that was pinned by a stale SW.
if ('serviceWorker' in navigator) {
  var host = window.location.hostname;
  var isTauriShell = window.location.protocol === 'tauri:' || !!(window.__TAURI_INTERNALS__ || window.__TAURI__);
  var shouldRegisterSW = !isTauriShell && (host === 'localhost' || host.endsWith('.trycloudflare.com'));
  window.addEventListener('load', function () {
    if (shouldRegisterSW) {
      navigator.serviceWorker.register('/sw.js')
        .then(function (reg) { console.log('SW registered:', reg.scope); })
        .catch(function (err) { console.warn('SW registration failed:', err); });
    } else {
      // Unregister any existing SW AND purge its precache — a shell pinned by a
      // stale SW keeps serving the old bundle from CacheStorage until both go.
      navigator.serviceWorker.getRegistrations().then(function (regs) {
        regs.forEach(function (reg) { reg.unregister(); });
      });
      if (window.caches && caches.keys) {
        caches.keys().then(function (keys) { keys.forEach(function (k) { caches.delete(k); }); });
      }
    }
  });
}

// ---- CSP hygiene: surface any policy violation (defense-in-depth telemetry) ----
// Silent, keepable: if a future change trips the Content-Security-Policy this logs
// the exact directive instead of failing invisibly.
document.addEventListener('securitypolicyviolation', function (e) {
  console.warn('[CSP] blocked', e.violatedDirective, '←', e.blockedURI || 'inline', e.sourceFile ? '(' + e.sourceFile + ':' + e.lineNumber + ')' : '');
});
