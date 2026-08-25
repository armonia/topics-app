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
  * @covers DOMCO-01
 */
import { describe, it, expect } from 'bun:test';

/**
 * FUORI dalla corsia unitaria per default, e non è pigrizia.
 *
 * Questo file lancia un Chromium VERO. Sotto carico l'avvio non rispetta un
 * tetto costante, e il timeout a 45s scattava a caso: misurato il 04/08, la
 * suite intera con loadavg ~14 lo dava rosso, lo stesso file isolato faceva 7
 * pass in 8,2 secondi. Tre volte in una sessione.
 *
 * Un rosso così MENTE: dice «il co-browse è rotto» quando il fatto è «questa
 * macchina era occupata». Chi lo incontra durante un'altra consegna deve
 * fermarsi a dimostrare che non è colpa sua — e il prossimo rosso VERO verrà
 * liquidato come «sarà il carico». È il costo che si paga davvero.
 *
 * Alzare il timeout sposterebbe la soglia senza togliere la bugia. Quindi il
 * file gira nella sua corsia: `bun run test:heavy` (o `TOPICS_HEAVY_TESTS=1`),
 * dove ha la macchina per sé e un rosso significa qualcosa.
 */
const HEAVY = process.env.TOPICS_HEAVY_TESTS === '1';
const describeHeavy = HEAVY ? describe : describe.skip;
import { createBrowserService } from './browser-service';
import type { BrowserWsMessage } from '../shared/browser-ws-messages';

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

describeHeavy('browser-service: DOM co-browse (real browser)', () => {
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

  it('first-touch race: concurrent getOrCreate + enableDomMode share ONE context', async () => {
    // The live pane's WS-open fires screencast-bootstrap (getOrCreate) and the
    // client's set_render:'dom' (enableDomMode → getOrCreate) CONCURRENTLY on a
    // context that doesn't exist yet. Without single-flight createContext each
    // racer built its own Playwright context; the loser leaked as an orphan page
    // carrying the rrweb recorder + 'load' re-arm — so navigation happened on
    // the winner while the mirror followed the orphan: blank forever.
    const emitted: { msg: BrowserWsMessage }[] = [];
    const svc = await createBrowserService({
      broadcastToBrowserWs: (_id, msg) => emitted.push({ msg }),
    });
    const RACE_MARKER = 'CIAO DOPO LA RACE';
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(
        `<!doctype html><html><head><title>RACE</title></head><body><h1>${RACE_MARKER}</h1></body></html>`,
        { headers: { 'content-type': 'text/html' } },
      ),
    });
    const id = `dom-cb-race-${Date.now()}`;
    try {
      const [boot] = await Promise.all([
        svc.enableDomMode(id),
        svc.getOrCreate(id),
      ]);
      expect(boot).not.toBeNull();
      await svc.navigate(id, `http://127.0.0.1:${server.port}/`);
      let freshFull = false;
      for (let i = 0; i < 60 && !freshFull; i++) {
        freshFull = emitted.some(
          (e) => e.msg.type === 'dom_event'
            && (e.msg as { event?: { type?: number } }).event?.type === 2
            && JSON.stringify(e.msg).includes(RACE_MARKER),
        );
        if (!freshFull) await new Promise((r) => setTimeout(r, 250));
      }
      expect(freshFull).toBe(true);
    } finally {
      server.stop(true);
      await svc.close();
    }
  }, 45000);

  it('enable racing a SLOW first navigation still bootstraps (no forced video)', async () => {
    // The live pane sends set_render:'dom' and its first nav back-to-back: the
    // injection lands on the provisional document, the (slow) goto then swaps
    // it mid-record, the snapshot never emits — and a fixed 2s wait gave up and
    // forced the client to video, with no retry path. enableDomMode must ride
    // through an in-flight navigation: wait for 'load', re-inject, THEN decide.
    const svc = await createBrowserService({ broadcastToBrowserWs: () => {} });
    const SLOW_MARKER = 'CIAO NAV LENTA';
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        await new Promise((r) => setTimeout(r, 1500)); // slow like a real site
        return new Response(
          `<!doctype html><html><head><title>SLOW</title></head><body><h1>${SLOW_MARKER}</h1></body></html>`,
          { headers: { 'content-type': 'text/html' } },
        );
      },
    });
    const id = `dom-cb-slow-${Date.now()}`;
    try {
      await svc.createContext(id);
      const [boot] = await Promise.all([
        svc.enableDomMode(id),
        svc.navigate(id, `http://127.0.0.1:${server.port}/`),
      ]);
      expect(boot).not.toBeNull();
      expect(JSON.stringify(boot)).toContain(SLOW_MARKER);
    } finally {
      server.stop(true);
      await svc.close();
    }
  }, 45000);

  it('re-arms after a navigation: enable on blank, navigate, fresh FullSnapshot broadcasts', async () => {
    // The real pane's sequence: the client asserts set_render:'dom' on WS-open,
    // BEFORE its nav lands — so enableDomMode runs against about:blank and the
    // real page's snapshot must come from the page.on('load') re-arm. That path
    // crosses a process swap (about:blank → http origin), which can invalidate
    // the cached recorder CDP session — the live repro was a mirror stuck on the
    // blank snapshot forever ("DOM surface visible, body empty").
    const emitted: { id: string; msg: BrowserWsMessage }[] = [];
    const svc = await createBrowserService({
      broadcastToBrowserWs: (id, msg) => emitted.push({ id, msg }),
    });
    const NAV_MARKER = 'CIAO DOPO NAV';
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(
        `<!doctype html><html><head><title>NAV</title></head><body><h1>${NAV_MARKER}</h1></body></html>`,
        { headers: { 'content-type': 'text/html' } },
      ),
    });
    const id = `dom-cb-navafter-${Date.now()}`;
    try {
      await svc.createContext(id);
      // Enable on the pristine blank page (the WS-open re-assert timing).
      const bootstrap = await svc.enableDomMode(id);
      expect(bootstrap).not.toBeNull();
      expect(JSON.stringify(bootstrap)).not.toContain(NAV_MARKER);
      // Now the nav lands — the 'load' re-arm must record the REAL page.
      await svc.navigate(id, `http://127.0.0.1:${server.port}/`);
      let freshFull = false;
      for (let i = 0; i < 60 && !freshFull; i++) {
        freshFull = emitted.some(
          (e) => e.msg.type === 'dom_event'
            && (e.msg as { event?: { type?: number } }).event?.type === 2
            && JSON.stringify(e.msg).includes(NAV_MARKER),
        );
        if (!freshFull) await new Promise((r) => setTimeout(r, 250));
      }
      expect(freshFull).toBe(true);
    } finally {
      server.stop(true);
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

  it("echoes EVERY typed keystroke to the fan-out (rrweb sampling.input='all')", async () => {
    // The "scrivo e non appare" gap: rrweb's sampling.input:'last' records only the
    // FINAL input value (on settle/blur), so a co-browse user typed and the mirror
    // stayed empty until they left the field. With 'all', each keystroke emits an
    // Input incremental (type 3, source 5) → live echo. This guards that config.
    const emitted: { msg: BrowserWsMessage }[] = [];
    const svc = await createBrowserService({
      broadcastToBrowserWs: (_id, msg) => emitted.push({ msg }),
    });
    const id = `dom-cb-input-${Date.now()}`;
    try {
      await svc.createContext(id);
      await svc.evaluate(id, "document.title='T'; document.body.innerHTML='<input id=\"q\" type=\"text\">';");
      const boot = await svc.enableDomMode(id);
      expect(boot).not.toBeNull();

      // Focus the field, then type char-by-char through the same path a relayed
      // keystroke takes (dispatchInput 'type' → page.keyboard.type).
      await svc.evaluate(id, "document.getElementById('q').focus();");
      const MARK = "HELLOECHO";
      for (const ch of MARK) await svc.dispatchInput(id, "type", { text: ch });
      await new Promise((r) => setTimeout(r, 600));

      // An Input incremental (type 3, data.source 5) must carry the typed value.
      const inputEvents = emitted
        .filter((e) => e.msg.type === "dom_event")
        .map((e) => (e.msg as { event?: { type?: number; data?: { source?: number; text?: string } } }).event)
        .filter((ev) => ev?.type === 3 && ev?.data?.source === 5);
      expect(inputEvents.length).toBeGreaterThan(0);
      // The last echoed value is the full string ('all' streamed the buildup).
      expect(inputEvents.some((ev) => ev?.data?.text === MARK)).toBe(true);
    } finally {
      await svc.close();
    }
  }, 45000);
});
