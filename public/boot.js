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

  // Keep the iOS/Android status-bar tint in lock-step with the resolved theme so
  // the safe-area zone reads as one continuous surface. Questi hex sono il
  // CHROME, non la pagina: la fascia di sistema è il bordo dell'app e deve
  // leggersi come la sidebar. MUST match `--chrome-bg` in index.css
  // (light #eaecf0 / dark #080a0e) e il manifest.
  try {
    var tc = document.querySelector('meta[name="theme-color"]');
    if (tc) tc.setAttribute('content', dark ? '#080a0e' : '#eaecf0');
  } catch (e) {}

  // Desktop on macOS: tag <html> so the app can let native window vibrancy show
  // through the chrome. Set before first paint so the opaque base never masks the
  // blur. Driven by per-region NSVisualEffectViews on the Tauri shell
  // (vibrancy_set_regions, from useFloatingVibrancy). `.electron-mac` is the
  // shell-neutral base-transparency hook (legacy name kept — referenced in CSS);
  // `.tauri-mac` is the Tauri-mac gate.
  try {
    // navigator.platform is deprecated and can be empty in a WKWebView — OR it
    // with the userAgent (always contains "Mac OS X").
    var __isMac = /Mac/i.test(navigator.platform || '') || /Mac OS X/i.test(navigator.userAgent || '');
    // __TAURI_INTERNALS__ is injected at document-start but not guaranteed before
    // this synchronous script — ALSO key on the custom origin (tauri://localhost),
    // available synchronously. Either signal is enough.
    var __isTauri = !!(window.__TAURI_INTERNALS__ || window.__TAURI__)
      || location.protocol === 'tauri:'
      || /(^|\.)tauri\.localhost$/i.test(location.hostname || '');
    var __isTauriMac = __isTauri && __isMac;
    if (__isTauriMac) {
      document.documentElement.classList.add('electron-mac');
      document.documentElement.classList.add('tauri-mac');
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
