/**
 * T1 DOM co-browse — server path against a REAL headless Chromium (the only
 * browser-service test that actually launches one, so it's gated to this feature
 * and given a generous timeout). Verifies the novel server logic end-to-end:
 *   • enableDomMode injects rrweb and returns a bootstrap with a FullSnapshot
 *     (type 2) carrying the page's real text,
 *   • live DOM mutations broadcast `dom_event` incrementals to the WS fan-out,
 *   • setDomEmit(false) DETACHES the recorder — no new events after (revocable
 *     instrumentation, the fix for the commit-B security review).
 *
 * Deterministic + offline: content is built with evaluate() on about:blank (no
 * network, no data:/scheme questions), including a ticking mutation.
 */
import { describe, it, expect } from 'bun:test';
import { createBrowserService } from './browser-service';
import type { BrowserWsMessage } from './browser-ws-messages';

// A real page whose Content-Security-Policy refuses inline <script> — like GitHub,
// Google, and most of the modern web. rrweb MUST still record here: injecting via a
// <script> tag (addScriptTag) is blocked by this CSP, so the injection has to run as
// the debugger (CDP-exempt) instead. This is the regression behind "metto DOM ma
// esce sempre video" — under CSP the recorder never started, so no events flowed.
const CSP_MARKER = 'CIAO SOTTO CSP';
const CSP_HTML = `<!doctype html><html><head><title>CSP</title></head>
<body><h1 id="hi">${CSP_MARKER}</h1></body></html>`;

const BUILD_PAGE = `
  document.title = 'DOMCB';
  document.body.innerHTML = '<h1 id="hi">CIAO DOM COBROWSE</h1><ul id="feed"></ul>';
  window.__t && clearInterval(window.__t);
  window.__t = setInterval(function () {
    var li = document.createElement('li');
    li.textContent = 'tick ' + Date.now();
    document.getElementById('feed').appendChild(li);
  }, 150);
`;

describe('browser-service: DOM co-browse (real browser)', () => {
  it('enableDomMode bootstraps a FullSnapshot, streams incrementals, and setDomEmit(false) stops', async () => {
    const emitted: { id: string; msg: BrowserWsMessage }[] = [];
    const svc = await createBrowserService({
      broadcastToBrowserWs: (id, msg) => emitted.push({ id, msg }),
    });
    const id = 'dom-cb-1';
    try {
      await svc.createContext(id);
      // Build a deterministic DOM + a ticking mutation directly in the page.
      await svc.evaluate(id, BUILD_PAGE);

      // Enable DOM mode → rrweb injected, bootstrap returned.
      const bootstrap = await svc.enableDomMode(id);
      expect(bootstrap).not.toBeNull();
      const types = (bootstrap ?? []).map((e) => (e as { type?: number })?.type);
      expect(types).toContain(4); // Meta
      expect(types).toContain(2); // FullSnapshot
      // The FullSnapshot serializes the real DOM text.
      expect(JSON.stringify(bootstrap)).toContain('CIAO DOM COBROWSE');

      // The ticking feed → live dom_event incrementals over the fan-out.
      await new Promise((r) => setTimeout(r, 800));
      const domEventCount = () => emitted.filter((e) => e.msg.type === 'dom_event').length;
      expect(domEventCount()).toBeGreaterThan(0);

      // Revocable: stop emission → detach the recorder. No NEW events after a beat.
      svc.setDomEmit(id, false);
      await new Promise((r) => setTimeout(r, 250)); // let the RRWEB_STOP land
      const before = domEventCount();
      await new Promise((r) => setTimeout(r, 800));
      expect(domEventCount()).toBe(before);
    } finally {
      await svc.close();
    }
  }, 45000);

  it('a second enable while the recorder is live still bootstraps (late joiner / reconnect)', async () => {
    const svc = await createBrowserService({ broadcastToBrowserWs: () => {} });
    const id = 'dom-cb-rejoin';
    try {
      await svc.createContext(id);
      // STATIC page — no mutations. rrweb only emits Meta+FullSnapshot at
      // record() start, so if the second enable no-ops on the already-running
      // recorder, its (reset) buffer never fills and enableDomMode returns null
      // → the server forces the joining viewer to video. This is the live
      // "second viewer / WS-reconnect re-assert lands on video" repro.
      await svc.evaluate(id, "document.title='DOMCB2'; document.body.innerHTML='<h1>STATICO REJOIN</h1>';");
      const first = await svc.enableDomMode(id);
      expect(first).not.toBeNull();
      const second = await svc.enableDomMode(id);
      expect(second).not.toBeNull();
      const types = (second ?? []).map((e) => (e as { type?: number })?.type);
      expect(types).toContain(4); // fresh Meta
      expect(types).toContain(2); // fresh FullSnapshot (takeFullSnapshot checkout)
      expect(JSON.stringify(second)).toContain('STATICO REJOIN');
    } finally {
      await svc.close();
    }
  }, 45000);

  it('bootstraps a FullSnapshot even when the page CSP forbids inline scripts', async () => {
    const svc = await createBrowserService({ broadcastToBrowserWs: () => {} });
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(CSP_HTML, {
          headers: {
            'content-type': 'text/html',
            // Blocks any injected inline <script> (no 'unsafe-inline'): the exact
            // condition that silenced rrweb on real sites.
            'content-security-policy': "default-src 'self'; script-src 'self'; object-src 'none'",
          },
        }),
    });
    // Unique id per run: createContext restores a persisted last-url, and a fixed
    // id would point at a PRIOR run's now-dead ephemeral port, whose failed restore
    // navigation races (and interrupts) ours.
    const id = `dom-cb-csp-${Date.now()}`;
    try {
      await svc.createContext(id);
      const nav = await svc.navigate(id, `http://127.0.0.1:${server.port}/`);
      expect(nav.error).toBeUndefined();

      const bootstrap = await svc.enableDomMode(id);
      expect(bootstrap).not.toBeNull();
      const types = (bootstrap ?? []).map((e) => (e as { type?: number })?.type);
      expect(types).toContain(2); // FullSnapshot — rrweb actually ran under CSP
      expect(JSON.stringify(bootstrap)).toContain(CSP_MARKER);
    } finally {
      server.stop(true);
      await svc.close();
    }
  }, 45000);
});
