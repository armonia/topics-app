/**
 * AI RESPONSE TIME — the instrument, i.e. everything that runs INSIDE the page,
 * plus the one lever that cannot (`installAcceptStall`, which holds the request
 * in flight from the driver side).
 *
 * The body of `installProbe` is shipped to the browser by `addInitScript` as
 * SOURCE, so it may not read anything from module scope: the two stall
 * durations arrive as an argument. That constraint is why this lives in a file
 * of its own — the spec next door is the drive, and the drive never reaches
 * inside the page.
 *
 *   the probe            here                                   (in-page)
 *   the drive            tests/e2e/bench-ai-latency.spec.ts      (Playwright)
 *   the shape (pure)     scripts/bench/ai-latency-shape.ts
 *   the verdict (pure)   scripts/bench/ai-latency.ts
 */
import type { Page } from "@playwright/test";

export interface BenchFrame {
  at: number;
  type: string;
  messageId: string | null;
  content: string | null;
  /**
   * Carried by `stream:end`. It is how a run PROVES which of the two worlds it
   * ran in: a turn that reached a model names the model, a turn that never got
   * there reports `<synthetic>`. Without it, "the default mode spends no
   * tokens" would be a claim in a comment instead of a field in the output.
   */
  model: string | null;
}

export interface BenchSend {
  at: number;
  /**
   * Length of the JSON body in UTF-16 code units, not bytes. Counting bytes
   * means a TextEncoder pass over the whole body, and that pass would land
   * INSIDE `wireToAccepted` (it would run after the stamp and before the
   * thread is free to see the reply). The same trade the payload builder makes
   * for the same reason: this needs an order of magnitude, not a byte count.
   */
  bodyChars: number;
}

export interface BenchState {
  keydownAt: number | null;
  sends: BenchSend[];
  frames: BenchFrame[];
}

export interface BenchWant {
  selector: string;
  text: string;
  timeoutMs: number;
}

export interface BenchPaint {
  ms: number;
  frames: number;
}

export interface BenchApi {
  reset(): void;
  read(): BenchState;
  openSockets(): number;
  injectRaw(raw: string): void;
  injectAndPaint(raws: string[], want: BenchWant): Promise<BenchPaint>;
}

declare global {
  interface Window {
    __benchAi?: BenchApi;
  }
}

/**
 * Hold the POST in flight for `ms` before it reaches the server. The falsification
 * lever for `wireToAccepted`, which is the one leg whose cost is not on the main
 * thread. Installed only when armed: intercepting a route costs a driver
 * round-trip per request, and paying that on every baseline run would tax the
 * very number this measures.
 */
export async function installAcceptStall(page: Page, ms: number): Promise<void> {
  await page.route("**/api/chat", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await new Promise((r) => setTimeout(r, ms));
    await route.continue();
  });
}

/**
 * The page-side probe. Installed before `goto` so it wraps `fetch` and
 * `WebSocket` before the app ever touches them.
 *
 * The WebSocket tap registers its listener inside the constructor, which is
 * before useWebSocket assigns `ws.onmessage`. Listeners fire in registration
 * order, so the tap sees a frame at the earliest instant it is visible to any
 * JavaScript, and the deliver stall lands exactly where a real regression in
 * the reducer would.
 *
 * The two stalls are the falsification levers for the legs that ARE on the main
 * thread: `sendStallMs` blocks on keydown, ahead of React's handler, and
 * `deliverStallMs` blocks when a WS frame arrives, ahead of the app's
 * onmessage. Both busy-wait, because a timer is not a stall.
 */
export async function installProbe(
  page: Page,
  cfg: { sendStallMs: number; deliverStallMs: number },
): Promise<void> {
  await page.addInitScript((c: { sendStallMs: number; deliverStallMs: number }) => {
    const burn = (ms: number) => {
      const until = performance.now() + ms;
      // Busy-wait: a real main-thread stall, not a timer the scheduler can skip.
      while (performance.now() < until) { /* burn */ }
    };

    const frames: BenchFrame[] = [];
    const sends: BenchSend[] = [];
    const sockets: WebSocket[] = [];
    const state = { keydownAt: null as number | null };
    /** Cap so a long run cannot grow the tap into a leak of its own. */
    const FRAME_CAP = 400;

    window.addEventListener(
      "keydown",
      (ev: KeyboardEvent) => {
        // `ev.timeStamp`, not `performance.now()`: it is the event's CREATION
        // time and shares the page's time origin, so anything that blocks the
        // thread between the input and React's handler is inside the interval.
        state.keydownAt = ev.timeStamp;
        if (c.sendStallMs > 0) burn(c.sendStallMs);
      },
      true,
    );

    const originalFetch = window.fetch;
    const nativeFetch = originalFetch.bind(window);
    // `Object.assign` and not a bare arrow: `fetch` can carry statics of its own
    // (`preconnect`, on the runtimes that have it), and a replacement missing
    // them is a narrower object than what anything reading `window.fetch` is
    // entitled to. Copying the original's own properties, rather than naming
    // one, keeps that true without depending on which lib declared them — and
    // in Chromium, where this actually runs, there are none to copy.
    const tap = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (method === "POST" && href.split("?")[0].endsWith("/api/chat")) {
        const body = init?.body;
        sends.push({ at: performance.now(), bodyChars: typeof body === "string" ? body.length : 0 });
      }
      return nativeFetch(input, init);
    };
    window.fetch = Object.assign(tap, originalFetch);

    const NativeWebSocket = window.WebSocket;
    class TappedWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        const href = typeof url === "string" ? url : url.href;
        // Only the app's own socket. Terminals, browser panes and the Vite HMR
        // channel each open their own, and none of them carries chat frames.
        if (!href.split("?")[0].endsWith("/ws")) return;
        sockets.push(this);
        this.addEventListener("message", (ev: MessageEvent<string>) => {
          const at = performance.now();
          if (c.deliverStallMs > 0) burn(c.deliverStallMs);
          let type = "";
          let messageId: string | null = null;
          let content: string | null = null;
          let model: string | null = null;
          try {
            const parsed: unknown = JSON.parse(ev.data);
            if (parsed && typeof parsed === "object") {
              const frame = parsed as {
                type?: unknown;
                messageId?: unknown;
                content?: unknown;
                model?: unknown;
              };
              if (typeof frame.type === "string") type = frame.type;
              if (typeof frame.messageId === "string") messageId = frame.messageId;
              if (typeof frame.content === "string") content = frame.content.slice(0, 200);
              if (typeof frame.model === "string") model = frame.model;
            }
          } catch {
            // Not JSON. Nothing this bench reads travels as anything else.
          }
          if (!type) return;
          frames.push({ at, type, messageId, content, model });
          if (frames.length > FRAME_CAP) frames.splice(0, frames.length - FRAME_CAP);
        });
      }
    }
    window.WebSocket = TappedWebSocket as unknown as typeof WebSocket;

    const paintedCount = (want: BenchWant): number => {
      let n = 0;
      for (const el of Array.from(document.querySelectorAll(want.selector))) {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || style.opacity === "0") continue;
        if (!(el.textContent ?? "").includes(want.text)) continue;
        n++;
      }
      return n;
    };

    const liveSocket = (): WebSocket => {
      for (let i = sockets.length - 1; i >= 0; i--) {
        if (sockets[i].readyState === WebSocket.OPEN) return sockets[i];
      }
      throw new Error("bench: the app has no open WebSocket to deliver a frame on");
    };

    window.__benchAi = {
      reset() {
        frames.length = 0;
        sends.length = 0;
        state.keydownAt = null;
      },
      read() {
        return { keydownAt: state.keydownAt, sends: sends.slice(), frames: frames.slice() };
      },
      openSockets() {
        return sockets.filter((s) => s.readyState === WebSocket.OPEN).length;
      },
      injectRaw(raw: string) {
        liveSocket().dispatchEvent(new MessageEvent("message", { data: raw }));
      },
      injectAndPaint(raws: string[], want: BenchWant) {
        // Arming is asserted, the way helpers/ink.ts asserts it: a target that
        // is already on screen would answer ~0 ms whatever the app did.
        if (paintedCount(want) > 0) {
          return Promise.reject(
            new Error(`bench: the ink is ALREADY painted (${want.selector} + ${want.text})`),
          );
        }
        return new Promise<BenchPaint>((resolvePaint, rejectPaint) => {
          const socket = liveSocket();
          const deadline = performance.now() + want.timeoutMs;
          let t0 = 0;
          let seen = 0;
          let domReady = false;
          const tick = (ts: number) => {
            seen++;
            if (domReady) {
              // rAF runs before the paint of its frame, so the frame that put
              // the pixels out is this one.
              resolvePaint({ ms: ts - t0, frames: seen });
              return;
            }
            if (paintedCount(want) > 0) domReady = true;
            else if (performance.now() > deadline) {
              rejectPaint(new Error(`bench: the ink never painted (${want.selector} + ${want.text})`));
              return;
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
          t0 = performance.now();
          for (const raw of raws) {
            socket.dispatchEvent(new MessageEvent("message", { data: raw }));
          }
        });
      },
    };
  }, cfg);
}
