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
});
