import { test as base, type Page, type Route, type WebSocketRoute } from "@playwright/test";
import { BrowserProcessPage } from "./browser.fixture";
import type { ElementDescription } from "../../../shared/element-describe";

/**
 * Phase 30 BROWSER-CHAT-02..04 fixture extension.
 *
 * Extends BrowserProcessPage (phase 27) with WebSocket-aware mocks for the
 * /ws/browser/:contextId bridge plus tool-agent / select-element helpers
 * used by plans 30-02..30-05 spec files.
 *
 * Status: Wave-0 stubs filled in plan 30-05.
 */
export class BrowserProcessPageV2 extends BrowserProcessPage {
  // Active WS route reference; set by mockBrowserWs, used by closeWs +
  // broadcastAgentActive helpers. Public so tests don't need a getter.
  private wsRouteRef: WebSocketRoute | null = null;

  // Number of times the client has (re)connected to /ws/browser/ — the mock's
  // routeWebSocket handler runs once per connection. A reconnect after closeWs()
  // increments this, which is how the reconnect test observes recovery without
  // racing the connection-indicator class.
  private wsConnectCount = 0;

  // Inbound (client -> server) messages recorded when mockBrowserWs is
  // configured with recordInbound (default true).
  private recordedInboundMessages: unknown[] = [];

  // Whether mockMoondream has installed its page.route guard yet (avoid
  // duplicate installs across multiple test calls).
  private moondreamInterceptInstalled = false;

  // Engine switch (task 54601eeb): the extension count the mock WS echoes back
  // when the client sends set_engine (simulates the server's engine broadcast).
  private engineReplyExtensions = 42;

  // WebRTC shared-session transport (2026-07): the streaming pane renders the
  // H.264 <video> (not a JPEG <img>) once the transport connects. When a test
  // opts in via mockWebrtcPeer(), the mock WS answers the client's webrtc_offer
  // and a fake RTCPeerConnection (installed in the page) drives ICE to
  // 'connected' + fires ontrack — so [data-testid=browser-webrtc-video] becomes
  // the visible surface deterministically, with no real sidecar/ICE/UDP.
  private webrtcMockEnabled = false;

  // T1 DOM co-browse: rrweb events the mock WS replays when the client requests
  // DOM render mode (set_render:'dom'). Null until a test opts in via
  // mockDomCoBrowse(); when set, the mock answers with render_mode + the burst.
  private domCobrowseEvents: unknown[] | null = null;

  // Option A: simulate a page the server can't DOM-snapshot (canvas/WebGL, or an
  // rrweb bootstrap that yields no FullSnapshot). When set, the mock forces
  // render_mode:'video' for ANY set_render:'dom' — mirroring the real server — so
  // the pane must gracefully fall back to the pixel (WebRTC) surface.
  private domUnsupported = false;

  // Che campo è a fuoco nella pagina remota dopo un click: la risposta che il
  // vero server manda leggendo `document.activeElement` con Playwright. È
  // l'unica via che il ramo video ha per sapere quale tastiera aprire (lì non
  // c'è nessun mirror da interrogare). `undefined` = il mock non risponde
  // affatto (server vecchio); `null` = risponde «niente di scrivibile».
  private focusFieldReply: Record<string, unknown> | null | undefined = undefined;

  constructor(page: Page) {
    super(page);
  }

  /**
   * Mock the /ws/browser/:contextId endpoint via page.routeWebSocket.
   * Replays a deterministic frame sequence on connect + records inbound
   * input messages for assertions.
   *
   * Usage:
   *   await fixture.mockBrowserWs();                           // 15 fps default frames
   *   await fixture.mockBrowserWs({ framesPerSecond: 30 });    // tighter window
   *   await fixture.mockBrowserWs({ autoCloseAfterMs: 1500 }); // simulate WS drop
   */
  async mockBrowserWs(opts?: {
    framesPerSecond?: number;       // default 15
    framePayloadBase64?: string;    // default tiny 1x1 jpeg
    autoCloseAfterMs?: number;      // simulate disconnect
    recordInbound?: boolean;        // default true — record client -> server messages
  }): Promise<void> {
    const fps = opts?.framesPerSecond ?? 15;
    const intervalMs = Math.max(1, Math.round(1000 / fps));
    // tiny 1x1 jpeg base64 fallback (realistic frame payload, ~150 bytes)
    const frameB64 = opts?.framePayloadBase64
      ?? '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/AP8An/8A/9k=';
    this.recordedInboundMessages = [];
    this.wsConnectCount = 0;
    const recordInbound = opts?.recordInbound !== false;

    await this.page.routeWebSocket(/\/ws\/browser\//, async (ws) => {
      this.wsRouteRef = ws;
      this.wsConnectCount += 1;
      ws.onMessage((msg) => {
        let parsed: unknown = null;
        try { parsed = JSON.parse(String(msg)); } catch { /* non-JSON */ }
        if (recordInbound) {
          this.recordedInboundMessages.push(parsed ?? String(msg));
        }
        // Engine switch: mirror the server — a set_engine request is answered
        // with an engine broadcast (which flips the client badge + remounts).
        if (parsed && typeof parsed === 'object' && (parsed as { type?: string }).type === 'set_engine') {
          const engine = (parsed as { engine?: string }).engine === 'chromium' ? 'chromium' : 'native';
          try {
            ws.send(JSON.stringify({
              type: 'engine',
              engine,
              ...(engine === 'chromium' ? { extensions: this.engineReplyExtensions } : {}),
            }));
          } catch { /* ignore */ }
        }
        // Dopo un click relayato, il vero server legge chi ha preso il fuoco
        // nella pagina e lo rimanda a CHI ha cliccato: è così che il ramo video
        // sa quale tastiera far aprire al telefono. Il mock fa lo stesso, con la
        // risposta che il test ha preparato.
        if (this.focusFieldReply !== undefined
          && parsed && typeof parsed === 'object'
          && (parsed as { type?: string }).type === 'input'
          && (parsed as { action?: string }).action === 'click') {
          const field = this.focusFieldReply;
          try {
            ws.send(JSON.stringify({ type: 'focus_field', ...(field ? { field } : {}) }));
          } catch { /* ignore */ }
        }
        // WebRTC shared-session: answer the client's offer so the fake peer
        // (mockWebrtcPeer) drives ICE→connected on setRemoteDescription. Only
        // when a test opted in — otherwise the real RTCPeerConnection would just
        // reject this stub SDP (harmless) and those tests don't view the video.
        if (this.webrtcMockEnabled && parsed && typeof parsed === 'object' && (parsed as { type?: string }).type === 'webrtc_offer') {
          const streamId = (parsed as { stream?: string }).stream;
          try {
            ws.send(JSON.stringify({
              type: 'webrtc_answer',
              sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 H264/90000\r\n',
              ...(streamId ? { stream: streamId } : {}),
            }));
          } catch { /* ignore */ }
        }
        // DOM co-browse — mirror the server, which ALWAYS answers set_render. Option
        // A makes the client default to 'dom', so this must reply even for tests that
        // never opted into DOM: 'dom'+bootstrap only when the test provided rrweb
        // events (and didn't force unsupported), otherwise render_mode:'video' — the
        // server's "can't snapshot this page" path. That forced 'video' is what every
        // pixel/WebRTC test relies on to reach the <video> surface under the new default.
        if (parsed && typeof parsed === 'object' && (parsed as { type?: string }).type === 'set_render') {
          const requested = (parsed as { mode?: string }).mode === 'dom' ? 'dom' : 'video';
          const canDom = requested === 'dom' && !!this.domCobrowseEvents && !this.domUnsupported;
          const mode = canDom ? 'dom' : 'video';
          try {
            ws.send(JSON.stringify({ type: 'render_mode', mode }));
            if (canDom) {
              for (const event of this.domCobrowseEvents!) {
                ws.send(JSON.stringify({ type: 'dom_event', event }));
              }
            }
          } catch { /* ignore */ }
        }
      });
      // Send first frame within ~50ms (well under 500ms target)
      setTimeout(() => {
        try {
          ws.send(JSON.stringify({
            type: 'frame',
            data: frameB64,
            metadata: { pageScaleFactor: 1, timestamp: Date.now() },
          }));
        } catch { /* ignore */ }
      }, 50);
      // Push frames at fps rate
      const interval = setInterval(() => {
        try {
          ws.send(JSON.stringify({
            type: 'frame',
            data: frameB64,
            metadata: { pageScaleFactor: 1, timestamp: Date.now() },
          }));
        } catch {
          clearInterval(interval);
        }
      }, intervalMs);
      if (opts?.autoCloseAfterMs) {
        setTimeout(() => {
          clearInterval(interval);
          try { ws.close(); } catch { /* ignore */ }
        }, opts.autoCloseAfterMs);
      }
    });
  }

  /**
   * Opt this test into the WebRTC shared-session transport: the streaming pane's
   * visible surface is the H.264 <video> (data-testid=browser-webrtc-video), not
   * a JPEG <img>. Installs a fake RTCPeerConnection in the page that answers the
   * negotiation deterministically — createOffer resolves, and on
   * setRemoteDescription (the mock WS's webrtc_answer) it fires ontrack with a
   * synthetic stream and drives iceConnectionState to 'connected' — so the hook
   * flips webrtcActive=true and the <video> becomes visible. No sidecar, no real
   * ICE/UDP, no flake. Call BEFORE goToApp() (addInitScript runs pre-page-load);
   * pairs with mockBrowserWs() (which answers webrtc_offer once this is enabled).
   */
  async mockWebrtcPeer(): Promise<void> {
    this.webrtcMockEnabled = true;
    await this.page.addInitScript(() => {
      const RealMediaStream = window.MediaStream;
      class FakeRTCPeerConnection {
        private _ice = 'new';
        private _sig = 'stable';
        ontrack: ((ev: unknown) => void) | null = null;
        onicecandidate: ((ev: unknown) => void) | null = null;
        oniceconnectionstatechange: (() => void) | null = null;
        onconnectionstatechange: (() => void) | null = null;
        onsignalingstatechange: (() => void) | null = null;
        onicegatheringstatechange: (() => void) | null = null;
        get iceConnectionState() { return this._ice; }
        get iceGatheringState() { return this._ice === 'new' ? 'new' : 'complete'; }
        get connectionState() { return this._ice === 'connected' ? 'connected' : this._ice === 'closed' ? 'closed' : 'connecting'; }
        get signalingState() { return this._sig; }
        addTransceiver() { return {}; }
        addEventListener() { /* hook uses on* props */ }
        removeEventListener() { /* noop */ }
        getSenders() { return []; }
        getReceivers() { return []; }
        async createOffer() {
          return { type: 'offer', sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 H264/90000\r\n' };
        }
        async setLocalDescription() {
          this._sig = 'have-local-offer';
          // Emit a host candidate then end-of-candidates (mirrors a real gather).
          setTimeout(() => {
            try { this.onicecandidate?.({ candidate: { candidate: 'candidate:1 1 udp 2130706431 127.0.0.1 9 typ host', sdpMid: '0', sdpMLineIndex: 0 } }); } catch { /* noop */ }
            try { this.onicecandidate?.({ candidate: null }); } catch { /* noop */ }
          }, 0);
        }
        async setRemoteDescription() {
          this._sig = 'stable';
          // The answer arrived → attach a synthetic track, then walk ICE to
          // 'connected' so the hook sets webrtcActive=true and shows the <video>.
          setTimeout(() => {
            try { this.ontrack?.({ streams: [new RealMediaStream()], track: { kind: 'video' } }); } catch { /* noop */ }
            this._ice = 'checking';
            try { this.oniceconnectionstatechange?.(); } catch { /* noop */ }
            setTimeout(() => {
              this._ice = 'connected';
              try { this.oniceconnectionstatechange?.(); } catch { /* noop */ }
              try { this.onconnectionstatechange?.(); } catch { /* noop */ }
            }, 30);
          }, 0);
        }
        async addIceCandidate() { /* accept */ }
        async getStats() { return new Map(); }
        close() { this._ice = 'closed'; this._sig = 'closed'; }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).RTCPeerConnection = FakeRTCPeerConnection;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).webkitRTCPeerConnection = FakeRTCPeerConnection;
    });
  }

  /**
   * T1 DOM co-browse: opt this test into the DOM render path. The mock WS then
   * answers a client set_render:'dom' with render_mode:'dom' + the given rrweb
   * event burst (a real Meta+FullSnapshot(+incrementals) captured offline), so the
   * pane's rrweb Replayer reconstructs the page. Call after mockBrowserWs().
   */
  mockDomCoBrowse(events: unknown[]): void {
    this.domCobrowseEvents = events;
  }

  /**
   * Option A: opt this test into a page the server can't DOM-snapshot. The mock WS
   * then forces render_mode:'video' for any set_render:'dom' (no bootstrap), so the
   * pane — which defaults to DOM — must gracefully fall back to the pixel surface.
   * Pair with mockWebrtcPeer() to assert the video actually takes over.
   */
  mockDomUnsupported(): void {
    this.domUnsupported = true;
  }

  /**
   * Che campo il server dirà a fuoco dopo il prossimo click (e i successivi,
   * finché non si richiama). Passare `null` per la risposta «a fuoco non c'è
   * niente di scrivibile», che è quella che fa rientrare la tastiera.
   */
  mockFocusField(field: Record<string, unknown> | null): void {
    this.focusFieldReply = field;
  }

  /**
   * Drain the recorded inbound input messages (client -> server). Returns a
   * snapshot copy and clears the buffer for the next assertion window.
   */
  drainInputMessages(): unknown[] {
    const drained = [...this.recordedInboundMessages];
    this.recordedInboundMessages = [];
    return drained;
  }

  /**
   * Force-close the active WS route (simulates a transient server drop). The
   * client auto-reconnects — routeWebSocket re-accepts the next connection — so
   * the pane returns to live. To test the fallback-http FLOOR (no reconnect),
   * make the WebSocket constructor throw instead (see the fallback spec).
   */
  closeWs(): void {
    if (!this.wsRouteRef) throw new Error('mockBrowserWs() must be called first');
    try { this.wsRouteRef.close(); } catch { /* ignore */ }
    this.wsRouteRef = null;
  }

  /** How many times the client has (re)connected to /ws/browser/ so far. */
  getWsConnectCount(): number {
    return this.wsConnectCount;
  }

  /**
   * Attende che il client si sia DAVVERO connesso alla WS mockata.
   *
   * `wsRouteRef` nasce dentro l'handler di `routeWebSocket`, cioè solo DOPO che
   * il pane ha aperto la connessione. Montare il pane e sparare subito un
   * `broadcast*`/`send*` è una race che fallisce con "mockBrowserWs() must be
   * called first" — messaggio fuorviante: il mock c'era, era il client a non
   * essersi ancora collegato. Chi trasmette aspetta prima questo.
   */
  async waitForWsConnected(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.wsRouteRef) {
      if (Date.now() > deadline) {
        throw new Error(`WS mock: il client non si è connesso entro ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** Send a synthetic download message over the active WS route. */
  sendDownload(info: { filename: string; href: string; size?: number; state: 'started' | 'completed' | 'failed' }): void {
    if (!this.wsRouteRef) throw new Error('mockBrowserWs() must be called first');
    this.wsRouteRef.send(JSON.stringify({ type: 'download', ...info }));
  }

  /** Send a synthetic console message over the active WS route. */
  sendConsole(level: 'log' | 'warn' | 'error', text: string): void {
    if (!this.wsRouteRef) throw new Error('mockBrowserWs() must be called first');
    this.wsRouteRef.send(JSON.stringify({ type: 'console', level, text }));
  }

  /**
   * Engine switch (task 54601eeb): mock GET /api/browsers/engines — the
   * capability the client reads to decide whether to show the Native↔Chromium
   * toggle. Also sets the extension count the WS echoes on set_engine.
   */
  async mockEngines(info: { enabled: boolean; available?: boolean; engine?: string; extensions?: number }): Promise<void> {
    if (typeof info.extensions === 'number') this.engineReplyExtensions = info.extensions;
    await this.page.route(/\/api\/browsers\/engines$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          info.enabled
            ? { enabled: true, chromium: { available: info.available !== false, engine: info.engine ?? 'Google Chrome', extensions: info.extensions ?? 42 } }
            : { enabled: false },
        ),
      });
    });
  }

  /** Send a synthetic engine broadcast over the active WS route. */
  sendEngine(engine: 'native' | 'chromium', extensions?: number): void {
    if (!this.wsRouteRef) throw new Error('mockBrowserWs() must be called first');
    this.wsRouteRef.send(JSON.stringify({ type: 'engine', engine, ...(typeof extensions === 'number' ? { extensions } : {}) }));
  }

  /**
   * Mock the Moondream cloud API endpoint via page.route.
   * If `handler` is null/undefined, returns the default success shape (one
   * point at center).
   *
   * NOTE: page.route intercepts BROWSER-side fetches. The Moondream client
   * runs server-side (Bun), so this mock fires only when a test triggers
   * the call from the page context. For server-side dispatch, the failsoft
   * branch fires when MOONDREAM_API_KEY is unset (test server default).
   *
   * Useful patterns:
   *   - mockMoondream() — success path with default point
   *   - mockMoondream(async (route) => route.fulfill({status: 401, body: 'no auth'}))
   *   - mockMoondream(async (route) => route.fulfill({status: 200, body: '{"points":[]}'}))
   */
  async mockMoondream(handler?: (route: Route) => Promise<void> | void): Promise<void> {
    if (this.moondreamInterceptInstalled) return;
    this.moondreamInterceptInstalled = true;
    await this.page.route(/api\.moondream\.ai\/v1\/point/, async (route) => {
      if (handler) {
        await handler(route);
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ points: [{ x: 0.5, y: 0.5 }] }),
        });
      }
    });
  }

  /**
   * Mock POST /api/browsers/:id/inspect with deterministic DOM info.
   * Used by Cmd+Shift+E select-element tests.
   *
   * IMPORTANT — bbox shape MUST match production
   * (server/browser-service.ts:953 resolveElementAtPoint +
   * client/src/components/Browser/SelectElementOverlay.tsx:71 consumer):
   * { x, y, w, h } — NOT { x, y, width, height }. The overlay reads bbox.w
   * and bbox.h directly; using width/height would render zero-sized boxes.
   */
  async mockInspect(canned: {
    path: string;
    cssPath: string;
    bbox: { x: number; y: number; w: number; h: number };
    text?: string;
  }): Promise<void> {
    await this.page.route(/\/api\/browsers\/[^/]+\/inspect$/, async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(canned),
        });
      } else {
        await route.fallback();
      }
    });
  }

  /**
   * Mock POST /api/browsers/:id/describe-element — l'endpoint del CLICK (4.2),
   * quello che torna markup + stile calcolato + ritaglio. `/inspect` resta
   * separato: lo chiama l'hover, e i due test non devono incrociarsi.
   */
  async mockDescribeElement(canned: ElementDescription): Promise<void> {
    await this.page.route(/\/api\/browsers\/[^/]+\/describe-element$/, async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(canned),
        });
      } else {
        await route.fallback();
      }
    });
  }

  /**
   * Send a synthetic agent_active broadcast over the active WS route,
   * simulating an LLM tool call entry/exit. Used by overlay/lock tests
   * that don't need a real provider in the loop. Does NOT actually invoke
   * a handler.
   *
   * Pair true -> false to close the cycle.
   */
  broadcastAgentActive(active = true): void {
    if (!this.wsRouteRef) throw new Error('mockBrowserWs() must be called first');
    this.wsRouteRef.send(JSON.stringify({ type: 'agent_active', active }));
  }

  /**
   * Intercept the provider's outbound HTTP request (api.anthropic.com or
   * api.openai.com) and capture options.tools as sent. Returns a promise
   * that resolves once the provider has been called.
   *
   * Use BEFORE the chat send is triggered. Pair with the user typing
   * `@browser ...` in the chat input.
   */
  async assertProviderToolsPassed(
    providerName: 'anthropic' | 'openai',
  ): Promise<{ tools: { name: string }[] }> {
    const urlPattern = providerName === 'anthropic'
      ? /api\.anthropic\.com\/v1\/messages/
      : /api\.openai\.com\/v1\/chat\/completions/;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`No ${providerName} request captured`)),
        15000,
      );
      this.page.route(urlPattern, async (route) => {
        try {
          const body = JSON.parse(route.request().postData() || '{}');
          clearTimeout(timeout);
          // Anthropic: body.tools = [{name, ...}];
          // OpenAI: body.tools = [{type:'function', function:{name, ...}}]
          const tools: { name: string }[] = (body.tools ?? []).map(
            (t: { name?: string; function?: { name?: string } }) => ({
              name: t.name ?? t.function?.name ?? '',
            }),
          );
          resolve({ tools });
          // Fulfill with a minimal response so the provider doesn't 5xx the test
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              content: [{ type: 'text', text: 'mocked' }],
              stop_reason: 'end_turn',
            }),
          });
        } catch (err) {
          clearTimeout(timeout);
          reject(err);
        }
      });
    });
  }
}

export const test = base.extend<{ browserProcessPageV2: BrowserProcessPageV2 }>({
  browserProcessPageV2: async ({ page }, use) => {
    await use(new BrowserProcessPageV2(page));
  },
});

export { expect } from "@playwright/test";
