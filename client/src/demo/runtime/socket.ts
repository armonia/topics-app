/* WebSocket stand-in: the demo has no server, so every socket the client opens
 * is answered locally with the scenario's canned frames.
 *   /ws/terminal/<id>  -> the session's transcript, then replay-end
 *   /ws/browser/<id>   -> nav + one frame + the recorded rrweb snapshot
 *   /ws (main)         -> terminal sessions and window presence
 * The delays are the ones the original shim used; the landing's choreography
 * and its screenshots were tuned against them. */
import type { BrowserWsMessage } from "../../../../shared/browser-ws-messages";
import type { LandingScenario } from "../scenario";

type Listener = (this: StubSocketShape, ev: StubSocketEvent) => void;
interface StubSocketEvent { type?: string; target?: StubSocketShape; currentTarget?: StubSocketShape; data?: string; code?: number; reason?: string; wasClean?: boolean }
type EventName = "open" | "message" | "close" | "error";

interface StubSocketShape {
  url: string;
  readyState: number;
  binaryType: string;
  bufferedAmount: number;
  extensions: string;
  protocol: string;
  onopen: Listener | null;
  onmessage: Listener | null;
  onclose: Listener | null;
  onerror: Listener | null;
  addEventListener(type: string, fn: Listener): void;
  removeEventListener(type: string, fn: Listener): void;
  send(): void;
  close(): void;
}

export function installSocketStub(scenario: LandingScenario): void {
  const { terminals, browser, main } = scenario.sockets;

  class StubSocket implements StubSocketShape {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;
    url: string;
    readyState = 0;
    binaryType = "blob";
    bufferedAmount = 0;
    extensions = "";
    protocol = "";
    onopen: Listener | null = null;
    onmessage: Listener | null = null;
    onclose: Listener | null = null;
    onerror: Listener | null = null;
    private readonly listeners: Record<string, Listener[]> = { open: [], message: [], close: [], error: [] };

    constructor(url?: string | URL) {
      this.url = String(url || "");
      setTimeout(() => { this.open(); }, 40);
    }

    addEventListener(type: string, fn: Listener): void { (this.listeners[type] || (this.listeners[type] = [])).push(fn); }
    removeEventListener(type: string, fn: Listener): void {
      const a = this.listeners[type];
      if (!a) return;
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    }
    send(): void {}
    close(): void { this.readyState = 3; this.emit("close", { code: 1000, reason: "", wasClean: true }); }

    private emit(type: EventName, ev: StubSocketEvent = {}): void {
      ev.type = type; ev.target = this; ev.currentTarget = this;
      const h = this[`on${type}`];
      if (typeof h === "function") { try { h.call(this, ev); } catch (_e) { /* a throwing handler must not stop the others */ } }
      const a = this.listeners[type] || [];
      for (const fn of a) { try { fn.call(this, ev); } catch (_e) { /* idem */ } }
    }
    private message(data: string): void { this.emit("message", { data }); }
    private later(ms: number, frame: unknown): void { setTimeout(() => { this.message(JSON.stringify(frame)); }, ms); }

    private open(): void {
      this.readyState = 1;
      this.emit("open", {});
      const u = this.url;
      if (/\/ws\/terminal\//.test(u)) {
        const idMatch = u.match(/\/ws\/terminal\/([^/?]+)/);
        const sid = idMatch ? idMatch[1] : "";
        const lines = terminals.transcripts[sid] ?? terminals.fallback;
        // Raw PTY semantics: a bare \n is line-feed only (the cursor drops a row
        // but keeps its column, a staircase). Emit CRLF so xterm returns to col 0.
        lines.forEach((l, i) => { setTimeout(() => { this.message(l.replace(/\n/g, "\r\n")); }, 120 + i * 90); });
        // SingleTerminalPane reads this control frame by its literal type.
        this.later(120 + lines.length * 90 + 40, { type: "replay-end" });
      } else if (/\/ws\/browser\//.test(u)) {
        /* The pane paints from rrweb `dom_event`s (a recorded Meta + FullSnapshot),
         * the same shape the product sends over this socket. The JPEG frame is
         * never rendered: useRemoteBrowser takes it as proof the stream is alive,
         * which clears the fallback-to-polling timer, so it still goes out. */
        this.later(80, { type: "nav", url: browser.url, phase: "response" } satisfies BrowserWsMessage);
        this.later(90, { type: "agent_active", active: false } satisfies BrowserWsMessage);
        this.later(140, { type: "frame", data: browser.frameB64, metadata: { timestamp: 1748856600000, pageScaleFactor: 1 } } satisfies BrowserWsMessage);
        browser.snapshot.forEach((ev, i) => { this.later(160 + i * 30, { type: "dom_event", event: ev } satisfies BrowserWsMessage); });
      } else {
        this.later(110, main.sessions);
        /* Window presence is deliberately NOT persisted: it is fed only by
         * `presence:windows` on the main socket, so this is the real channel.
         * presenceWindowsBroadcastSchema (shared/ws-outbound.ts) validates the
         * frame before it reaches the bus, and one wrong field drops it in
         * silence: that is why the scenario types it. */
        this.later(130, main.presence);
      }
    }
  }

  try {
    (window as unknown as { WebSocket: unknown }).WebSocket = StubSocket;
  } catch (_e) { /* read-only WebSocket: the app falls back to its offline state */ }
}
