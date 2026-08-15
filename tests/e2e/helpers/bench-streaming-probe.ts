/**
 * THE STREAMING BENCH — the instrument, i.e. everything that runs INSIDE the
 * page.
 *
 * Both functions here are shipped to the browser by `page.addInitScript` /
 * `page.evaluate`, which send the SOURCE of the function and not its closure.
 * So nothing in this file may read anything from module scope: every value the
 * probe needs arrives through `arm(options)` or through `window.__benchOn2`.
 * That constraint is why they live in a file of their own — three hundred lines
 * that cannot see the file they sit in are easier to trust when nothing else
 * shares the page with them.
 *
 *   the probe          here                                       (in-page)
 *   the drive          tests/e2e/bench-streaming.spec.ts          (Playwright)
 *   the shape          scripts/bench/streaming-shape.ts           (pure)
 *   the verdict        scripts/bench/streaming.ts                 (pure)
 */
import type { BenchMode, BurstRaw, Calibration } from "../../../scripts/bench/streaming-shape";

export interface ArmOptions {
  mode: BenchMode;
  /** The live bubble's id — the one passed to `stream:start`. */
  messageId: string;
  /** The running tool's id — the one passed to `stream:tool_call`. */
  toolCallId: string;
  tokenChars: number;
  /** Applied count that means "this burst has fully landed". */
  target: number;
  /** Delay above which a zero-delay task was provably waiting on somebody else. Calibrated. */
  blockedFloorMs: number;
  /**
   * FALLING BEHIND IS A RESULT, NOT A CRASH.
   *
   * The burst closes at `target` OR at this many milliseconds, whichever comes
   * first, and the report says how many chunks actually landed. The first draft
   * only closed at `target`, so the falsification run — a client made
   * genuinely, catastrophically slow — produced a timeout and an exit code that
   * means "not measurable" instead of the number that proves the point. A bench
   * that cannot describe a client falling behind cannot measure throughput.
   */
  deadlineMs: number;
  /**
   * When > 0 the probe watches for this many milliseconds and never looks at
   * progress: the QUIET baseline. Without it, "something outside the list moved
   * while a chunk landed" is unreadable — the sidebar's device readout and the
   * turn timer move on their own clocks, and every count would be blamed on the
   * stream.
   */
  quietWindowMs: number;
}

export interface BenchProbe {
  calibrate(windowMs: number): Promise<Calibration>;
  arm(options: ArmOptions): void;
  mark(): void;
  applied(): number;
  /** True once the burst has landed (or the quiet window has elapsed). */
  settled(): boolean;
  read(): BurstRaw;
}

export interface On2Knob {
  usPerMessage: number;
  messages: number;
}

declare global {
  interface Window {
    __benchStream?: BenchProbe;
    __benchOn2?: On2Knob;
  }
}

/* ────────────────────────────────────────────────────────────── the probe ── */

/**
 * Installed once per page. Everything it needs lives inside it: `page.evaluate`
 * ships the source, not the closure of this file.
 */
export function installProbe(): void {
  interface LayoutShiftSource {
    node?: Node | null;
  }
  interface LayoutShiftEntry extends PerformanceEntry {
    value: number;
    hadRecentInput: boolean;
    sources?: LayoutShiftSource[];
  }
  interface LoafScript {
    duration: number;
  }
  interface LoafEntry extends PerformanceEntry {
    blockingDuration?: number;
    scripts?: LoafScript[];
  }

  interface State {
    options: ArmOptions;
    listEl: Element | null;
    gaps: number[];
    tStart: number;
    tMark: number | null;
    tComplete: number | null;
    appliedAtStart: number;
    applied: number;
    progressReadable: boolean;
    hitDeadline: boolean;
    running: boolean;
    longtasks: number[];
    loafSupported: boolean;
    loafCount: number;
    loafScriptMs: number;
    loafBlockingMs: number;
    blockedMs: number;
    pings: number;
    shiftInside: number;
    shiftOutside: number;
    shiftUnattributed: number;
    mutationsInside: number;
    mutationsOutside: number;
    movers: Set<string>;
    observers: PerformanceObserver[];
    mutationObserver: MutationObserver | null;
    channel: MessageChannel | null;
  }

  let state: State | null = null;

  /** How many chunks the PAINTED page has applied. Zero parsing in text mode. */
  const readApplied = (o: ArmOptions): number => {
    if (o.mode === "text") {
      const nodes = document.querySelectorAll(
        `[data-testid="chat-message"][data-message-id="${o.messageId}"] .prose`,
      );
      if (nodes.length === 0) return -1;
      let chars = 0;
      for (const n of Array.from(nodes)) chars += (n.textContent ?? "").length;
      return Math.floor(chars / o.tokenChars);
    }
    const row = document.querySelector(`[data-testid="tool-call-row-${o.toolCallId}"]`);
    if (!row) return -1;
    // The head marker, kept by `clampBody` (which slices from the front) even
    // when the tool's output is past the 20 KB inline budget.
    const m = /\[k=(\d{6})\]/.exec(row.textContent ?? "");
    return m ? Number(m[1]) : -1;
  };

  /** The nearest thing a human can name, for a node that moved. */
  const describeNode = (n: Node | null | undefined): string => {
    let el: Element | null =
      n && n.nodeType === 1 ? (n as Element) : (n?.parentElement ?? null);
    let hops = 0;
    while (el && hops < 8) {
      const tid = el.getAttribute("data-testid");
      if (tid) return `[data-testid="${tid}"]`;
      const label = el.getAttribute("aria-label");
      if (label) return `[aria-label="${label}"]`;
      el = el.parentElement;
      hops++;
    }
    return "(unlabelled)";
  };

  const probe: BenchProbe = {
    /**
     * What an idle page costs the probe, so the burst numbers have a zero.
     *
     * The busy-time reading is a RATE DEFICIT: a zero-delay task posted in a
     * loop comes back N times a millisecond when the thread is free, and fewer
     * when it is not. Without this measurement there is no N, and "occupancy"
     * would be a number divided by a guess.
     */
    calibrate(windowMs: number): Promise<Calibration> {
      return new Promise<Calibration>((resolve) => {
        const ch = new MessageChannel();
        const delays: number[] = [];
        const t0 = performance.now();
        const deadline = t0 + windowMs;
        let last = t0;
        ch.port1.onmessage = () => {
          const now = performance.now();
          delays.push(now - last);
          last = now;
          if (now >= deadline) {
            ch.port1.close();
            ch.port2.close();
            const sorted = delays.sort((a, b) => a - b);
            const elapsed = now - t0;
            resolve({
              pings: sorted.length,
              idleRatePerMs: elapsed > 0 ? sorted.length / elapsed : 0,
              medianDelayMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
              p95DelayMs: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
            });
            return;
          }
          ch.port2.postMessage(0);
        };
        ch.port2.postMessage(0);
      });
    },

    arm(options: ArmOptions): void {
      const bubble = document.querySelector(
        `[data-testid="chat-message"][data-message-id="${options.messageId}"]`,
      );
      // "Outside the message area" needs the message area. The virtualized
      // scroller of the pane that owns the live bubble, never the first one on
      // the page: background panes stay mounted under display:none.
      const listEl =
        bubble?.closest('[data-testid="virtuoso-scroller"], [data-virtuoso-scroller]') ??
        document.querySelector('[data-testid="virtuoso-scroller"], [data-virtuoso-scroller]');

      const appliedAtStart = readApplied(options);
      const s: State = {
        options,
        listEl,
        gaps: [],
        tStart: performance.now(),
        tMark: null,
        tComplete: null,
        appliedAtStart: Math.max(0, appliedAtStart),
        applied: Math.max(0, appliedAtStart),
        progressReadable: appliedAtStart >= 0,
        hitDeadline: false,
        running: true,
        longtasks: [],
        loafSupported: false,
        loafCount: 0,
        loafScriptMs: 0,
        loafBlockingMs: 0,
        blockedMs: 0,
        pings: 0,
        shiftInside: 0,
        shiftOutside: 0,
        shiftUnattributed: 0,
        mutationsInside: 0,
        mutationsOutside: 0,
        movers: new Set<string>(),
        observers: [],
        mutationObserver: null,
        channel: null,
      };
      state = s;

      try {
        const po = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) s.longtasks.push(e.duration);
        });
        // `buffered: false`: only what happens INSIDE the burst.
        po.observe({ type: "longtask", buffered: false });
        s.observers.push(po);
      } catch {
        // No longtask support: the report says so via longtask_count on a run
        // the occupancy probe calls busy.
      }

      try {
        const po = new PerformanceObserver((list) => {
          for (const raw of list.getEntries()) {
            const e = raw as LoafEntry;
            s.loafCount++;
            s.loafBlockingMs += e.blockingDuration ?? 0;
            for (const script of e.scripts ?? []) s.loafScriptMs += script.duration;
          }
        });
        po.observe({ type: "long-animation-frame", buffered: false });
        s.observers.push(po);
        s.loafSupported = true;
      } catch {
        s.loafSupported = false;
      }

      try {
        const po = new PerformanceObserver((list) => {
          for (const raw of list.getEntries()) {
            const e = raw as LayoutShiftEntry;
            if (e.hadRecentInput) continue;
            const sources = e.sources ?? [];
            if (sources.length === 0) {
              s.shiftUnattributed += e.value;
              continue;
            }
            for (const src of sources) {
              const node = src.node ?? null;
              if (s.listEl && node && s.listEl.contains(node)) s.shiftInside += e.value;
              else {
                s.shiftOutside += e.value;
                if (s.movers.size < 12) s.movers.add(`shift ${describeNode(node)}`);
              }
            }
          }
        });
        po.observe({ type: "layout-shift", buffered: false });
        s.observers.push(po);
      } catch {
        // Same rule as longtask: absence shows up as a zero the report names.
      }

      const mo = new MutationObserver((records) => {
        for (const r of records) {
          if (s.listEl && s.listEl.contains(r.target)) s.mutationsInside++;
          else {
            s.mutationsOutside++;
            if (s.movers.size < 12) s.movers.add(`dom ${describeNode(r.target)}`);
          }
        }
      });
      mo.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
      s.mutationObserver = mo;

      // MAIN-THREAD COST, at finer grain than a long task.
      //
      // A long task only exists above 50 ms, so a client that pays 0.3 ms per
      // chunk 1500 times a second reports ZERO long tasks while burning half a
      // second. The same zero-delay task loop the calibration used answers both
      // halves of the question: how many round-trips it managed (the rate
      // deficit against the idle rate IS the busy time), and how much of its
      // waiting overshot the calibrated floor (the stalls a human would feel).
      const ch = new MessageChannel();
      s.channel = ch;
      let last = performance.now();
      ch.port1.onmessage = () => {
        if (!s.running) return;
        const now = performance.now();
        const delay = now - last;
        if (delay > s.options.blockedFloorMs) s.blockedMs += delay - s.options.blockedFloorMs;
        s.pings++;
        last = performance.now();
        ch.port2.postMessage(0);
      };
      ch.port2.postMessage(0);

      const quietMode = options.quietWindowMs > 0;
      if (quietMode) s.progressReadable = true;
      let lastFrame = 0;
      let firstFrame = 0;
      const tick = (t: number): void => {
        if (!s.running) return;
        if (lastFrame > 0) s.gaps.push(t - lastFrame);
        lastFrame = t;
        if (quietMode) {
          if (s.tComplete === null && t - firstFrame >= options.quietWindowMs) s.tComplete = t;
        } else {
          const applied = readApplied(s.options);
          if (applied >= 0) {
            s.progressReadable = true;
            s.applied = applied;
            if (s.tComplete === null && applied >= s.options.target) s.tComplete = t;
          }
          if (s.tComplete === null && t - firstFrame >= options.deadlineMs) {
            s.hitDeadline = true;
            s.tComplete = t;
          }
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame((t) => {
        lastFrame = t;
        firstFrame = t;
        requestAnimationFrame(tick);
      });
    },

    mark(): void {
      if (state) state.tMark = performance.now();
    },

    applied(): number {
      return state ? state.applied : -1;
    },

    settled(): boolean {
      return state !== null && state.tComplete !== null;
    },

    read(): BurstRaw {
      const s = state;
      if (!s) {
        throw new Error("bench probe: read() before arm()");
      }
      s.running = false;
      for (const po of s.observers) po.disconnect();
      s.mutationObserver?.disconnect();
      s.channel?.port1.close();
      s.channel?.port2.close();

      const ordered = [...s.gaps].sort((a, b) => a - b);
      const mid = Math.floor(ordered.length / 2);
      const main = document.querySelector('[role="main"]');
      return {
        listResolved: s.listEl !== null,
        progressReadable: s.progressReadable,
        paneCrashed: main !== null && /Try again|Ricarica/.test(main.textContent ?? ""),
        frames: s.gaps.length,
        worstGapMs: ordered.length ? ordered[ordered.length - 1] : 0,
        medianGapMs: ordered.length
          ? (ordered.length % 2 ? ordered[mid] : (ordered[mid - 1] + ordered[mid]) / 2)
          : 0,
        tStart: s.tStart,
        tMark: s.tMark,
        tComplete: s.tComplete,
        appliedAtStart: s.appliedAtStart,
        appliedAtEnd: s.applied,
        hitDeadline: s.hitDeadline,
        longtaskCount: s.longtasks.length,
        longtaskMs: s.longtasks.reduce((a, b) => a + b, 0),
        loafSupported: s.loafSupported,
        loafCount: s.loafCount,
        loafScriptMs: s.loafScriptMs,
        loafBlockingMs: s.loafBlockingMs,
        blockedMs: s.blockedMs,
        pings: s.pings,
        shiftInside: s.shiftInside,
        shiftOutside: s.shiftOutside,
        shiftUnattributed: s.shiftUnattributed,
        mutationsInside: s.mutationsInside,
        mutationsOutside: s.mutationsOutside,
        outsideMovers: [...s.movers],
      };
    },
  };

  window.__benchStream = probe;
}

/* ─────────────────────────────────────────────── the falsification knob ── */

/**
 * THE FALSIFICATION KNOB. `TOPICS_STREAM_ON2_US_PER_MSG=<µs>` makes the client
 * burn `µs × transcript-length` microseconds inside the task that parses each
 * arriving chunk — per-chunk work proportional to the transcript length, which
 * is exactly the defect the three August 2026 fixes removed, reproduced without
 * touching the client. A bench that has never been seen going red is decoration.
 *
 * `useWebSocket.ts:153` parses every inbound frame with `JSON.parse`, so
 * patching it puts the burn in the SAME task that will hand the frame to
 * `handleStreamEvent`, where a real regression would land. Blocking a real main
 * thread is the only falsification worth anything: moving a threshold would only
 * prove that `>` works.
 */
export function installOn2Knob(): void {
  const original = JSON.parse;
  JSON.parse = function patched(text: string, reviver?: (key: string, value: unknown) => unknown) {
    const knob = window.__benchOn2;
    if (
      knob &&
      knob.usPerMessage > 0 &&
      typeof text === "string" &&
      (text.includes('"stream:content_chunk"') || text.includes('"stream:tool_update"'))
    ) {
      const until = performance.now() + (knob.usPerMessage * knob.messages) / 1000;
      while (performance.now() < until) {
        /* burn: the point is that the main thread is really gone */
      }
    }
    return original(text, reviver);
  } as typeof JSON.parse;
}
