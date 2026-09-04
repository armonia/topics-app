/**
 * THE TWO THINGS A SLEEP WAS STANDING IN FOR: hydration, and rendered frames.
 *
 * A handful of specs used to write `await page.waitForTimeout(3000)` with a
 * comment like "let the store speak" or "a few more frames after the icon
 * appeared". Both are real conditions, and neither of them is a duration:
 *
 *   · HYDRATION. The app learns the server state twice over, and either door
 *     can be the first to open: the `ui-state:init` / `ui-state:updated` /
 *     `ui-state:patch` frames on the WebSocket (`syncWS.ts`), and the 500 ms
 *     fallback `GET /api/ui-state` in `bootstrap.ts`. Waiting three seconds
 *     asserts nothing about either: on a loaded machine the snapshot lands at
 *     3.2 s and the test measures the page BEFORE the state it claims to
 *     check, which is a red that names the wrong culprit.
 *
 *   · RENDERED FRAMES. "Let the fade land", "give it a few frames": what the
 *     test needs is that the browser actually painted, and a busy page paints
 *     fewer frames per second, not more. Counting `requestAnimationFrame`
 *     callbacks measures the thing itself and is free on an idle page.
 *
 * This probe lives entirely on the test side: it wraps `WebSocket` and
 * `fetch` in the page to COUNT, never to alter. The wrapper adds a listener
 * instead of replacing `onmessage`, and hands back the original response
 * untouched, so a spec that also intercepts hydration (see
 * `browser-tab-chrome.spec.ts`) keeps working.
 */
import { expect, type Locator, type Page } from "@playwright/test";

/** The key the pane store syncs under, both on the socket and over HTTP. */
const PANE_STORE_KEY = "pane-store-v2";

/** Shape the probe exposes on `window`. Kept flat so `waitForFunction` can read it cheaply. */
interface UiStateProbeState {
  /** rAF callbacks served since the probe started. */
  frames: number;
  /** Any authoritative ui-state answer: a socket frame or a successful fallback GET. */
  hydrations: number;
  /** The subset of those that carried the pane store key. */
  paneHydrations: number;
}

declare global {
  interface Window {
    __uiStateProbe?: UiStateProbeState;
  }
}

/**
 * Install the probe. Must run BEFORE the navigation you want to observe, and
 * it survives reloads (Playwright replays init scripts on every document), so
 * one call per test is enough even when the spec reloads the page. The
 * counters restart with each document, which is what a spec that reloads
 * wants: it waits for the hydration of the NEW page, not for the old count.
 */
export async function installUiStateProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = { frames: 0, hydrations: 0, paneHydrations: 0 };
    window.__uiStateProbe = state;

    const tick = () => {
      state.frames++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    const carriesPaneStore = (frame: Record<string, unknown>): boolean => {
      const key = "pane-store-v2";
      if (frame.type === "ui-state:init") {
        const data = frame.data as Record<string, unknown> | undefined;
        return !!data && data[key] != null;
      }
      if (frame.type === "ui-state:updated") return frame.key === key;
      if (frame.type === "ui-state:patch") {
        const entries = frame.entries as Record<string, unknown> | undefined;
        return !!entries && entries[key] != null;
      }
      return false;
    };

    const countFrame = (raw: unknown): void => {
      if (typeof raw !== "string" || !raw.includes('"ui-state:')) return;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }
      const type = frame.type;
      if (type !== "ui-state:init" && type !== "ui-state:updated" && type !== "ui-state:patch") return;
      state.hydrations++;
      if (carriesPaneStore(frame)) state.paneHydrations++;
    };

    const OriginalWebSocket = window.WebSocket;
    class ProbedWebSocket extends OriginalWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        // A plain listener, not `onmessage`: the app keeps its own handler and
        // the ordering of the delivered events does not change.
        this.addEventListener("message", (ev: MessageEvent) => countFrame(ev.data));
      }
    }
    window.WebSocket = ProbedWebSocket as unknown as typeof WebSocket;

    const originalFetch = window.fetch.bind(window);
    const probedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const res = await originalFetch(input, init);
      try {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
        if (method === "GET" && res.ok && /\/api\/ui-state(\?|$)/.test(url)) {
          state.hydrations++;
          state.paneHydrations++;
        }
      } catch {
        /* the probe must never change what the app sees */
      }
      return res;
    };
    // The cast keeps the extra statics of the platform `fetch` off the wrapper
    // signature; the app only ever calls it as a function.
    window.fetch = probedFetch as unknown as typeof fetch;
  });
}

/**
 * Wait until the page has received an authoritative ui-state answer. With
 * `key: "pane-store-v2"` it waits for one that carried the pane store, which
 * is the condition behind "once the store has spoken".
 */
export async function waitForUiStateHydrated(
  page: Page,
  opts: { min?: number; key?: typeof PANE_STORE_KEY; timeout?: number } = {},
): Promise<void> {
  const { min = 1, key, timeout = 15_000 } = opts;
  await page.waitForFunction(
    ({ min, pane }) => {
      const probe = window.__uiStateProbe;
      if (!probe) return false;
      return (pane ? probe.paneHydrations : probe.hydrations) >= min;
    },
    { min, pane: key === PANE_STORE_KEY },
    { timeout },
  );
}

/** The key to pass to `waitForUiStateHydrated` when only the pane store counts. */
export const PANE_STORE_HYDRATION = PANE_STORE_KEY;

/**
 * Wait for `n` more painted frames, starting from now. Replaces "give it half
 * a second so the jump, if any, falls in there": what the observer needs is
 * frames drawn, and this waits for exactly that however slow the machine is.
 */
export async function waitForFrames(page: Page, n: number, timeout = 15_000): Promise<void> {
  const from = await page.evaluate(() => window.__uiStateProbe?.frames ?? 0);
  await page.waitForFunction(
    ({ from, n }) => (window.__uiStateProbe?.frames ?? 0) >= from + n,
    { from, n },
    { timeout },
  );
}

/**
 * Resolve once the set of active pane tabs has stayed identical across `frames`
 * consecutive animation frames, and return it. This is the condition a spec
 * about boot focus really wants: not "six seconds have passed" but "the row
 * stopped changing its mind". A late hydrate that steals the focus keeps
 * resetting the counter, so it is still caught rather than slept through.
 */
export async function waitForStableActiveTabs(
  page: Page,
  opts: { frames?: number; timeout?: number } = {},
): Promise<string> {
  const { frames = 30, timeout = 15_000 } = opts;
  return page.evaluate(
    async ({ frames, timeout }) => {
      const read = () =>
        Array.from(document.querySelectorAll('[data-testid^="pane-tab-"][data-active="true"]'))
          .map((t) => t.getAttribute("data-testid") ?? "?")
          .sort()
          .join("+");
      const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
      const deadline = Date.now() + timeout;
      let signature = read();
      let stable = 0;
      while (stable < frames) {
        await nextFrame();
        const now = read();
        if (now === signature) stable++;
        else {
          signature = now;
          stable = 0;
        }
        if (Date.now() > deadline) {
          throw new Error(`the active tab row never settled: still "${signature || "-"}" after ${timeout}ms`);
        }
      }
      return signature || "-";
    },
    { frames, timeout },
  );
}

/**
 * Wait until nothing is animating inside `handle`. A CSS transition ends when
 * it ends: sampling an opacity mid-fade reads a value that means nothing, and
 * a fixed sleep is a bet on the duration written in the stylesheet today.
 */
export async function waitForAnimationsToSettle(handle: Locator, timeout = 10_000): Promise<void> {
  await expect
    .poll(() => handle.evaluate((el) => el.getAnimations().filter((a) => a.playState === "running").length), {
      timeout,
      message: "an animation on this element is still running",
    })
    .toBe(0);
}

/**
 * Wait until the project icon probe has been answered AND written down. The
 * store persists the answer under `topics-project-icon-cache-v4`, and only a
 * server-confirmed one (`v === true` for a "no icon", any 'has') gets there:
 * that entry is the proof the next reload will already know, which is the
 * whole point of the specs that used to sleep here.
 */
export async function waitForProjectIconAnswer(
  page: Page,
  projectPath: string,
  timeout = 15_000,
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((path) => {
          try {
            const raw = localStorage.getItem("topics-project-icon-cache-v4");
            if (!raw) return false;
            const entry = (JSON.parse(raw) as Record<string, { s?: string; v?: boolean }>)[path];
            if (!entry) return false;
            return entry.s === "has" || entry.v === true;
          } catch {
            return false;
          }
        }, projectPath),
      { timeout, message: `the icon probe for ${projectPath} was never answered and remembered` },
    )
    .toBe(true);
}
