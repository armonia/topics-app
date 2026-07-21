// Injected AFTER the vendored rrweb bundle (which sets window.rrweb). Starts the
// recorder in the SOURCE page and pipes every event to the host via the exposed
// binding `__rrwebEmit`. Guarded so multi-frame / re-injection on nav is a no-op.
//
// This is the ONLY code that must live in the page. Everything downstream (fan-out,
// roles, multi-session routing, input relay) is transport/host side — see the
// session broker (bridge/) so it is reused by BOTH co-op and multi-session.
(function () {
  if (window.__rrwebStarted) return;
  if (!window.rrweb || !window.rrweb.record) return;
  window.__rrwebStarted = true;

  function emit(payload) {
    try { window.__rrwebEmit && window.__rrwebEmit(JSON.stringify(payload)); } catch (_) {}
  }

  function start() {
    try {
      window.rrweb.record({
        emit: function (event) { emit({ kind: 'event', tPage: Date.now(), event: event }); },
        // Self-contained CSS so a follower renders faithfully without the source's
        // cross-origin stylesheets. Images stay by-URL (fetched natively by the
        // follower) — flip inlineImages on only for air-gapped fidelity.
        inlineStylesheet: true,
        inlineImages: false,
        collectFonts: false,
        recordCanvas: false, // canvas → pixel-island channel (Rust webrtc-bridge), not DOM
        sampling: { mousemove: 50, scroll: 100, media: 400, input: 'last' },
      });
      emit({ kind: 'status', tPage: Date.now(), status: 'recording' });
    } catch (e) {
      emit({ kind: 'error', tPage: Date.now(), error: String(e && e.message || e) });
    }
  }

  if (document.readyState === 'complete') start();
  else window.addEventListener('load', function () { start(); }, { once: true });
})();
