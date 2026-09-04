/**
 * THE RETURN, MEASURED — one arithmetic for every pane.
 *
 * `refresh-cls.spec.ts` wrote this method for the chat: arm a `layout-shift`
 * observer BEFORE any line of the app runs (`addInitScript`, `buffered: true`),
 * reload, watch for a fixed window without touching anything, then sum the
 * entries the way web-vitals does (session windows: 1s gap, 5s length, keep the
 * largest). Every pane now answers the same question, so the arithmetic lives
 * here instead of being copied: two numbers produced by two copies of a formula
 * are not comparable, and a number that is not comparable is not a measurement.
 *
 * The second thing this file measures is FULLNESS: how long after
 * `DOMContentLoaded` the surface stops being empty. A pane can score a perfect
 * CLS by drawing nothing for a second and then painting the finished layout in
 * one go, and that is not the gesture the card asks for. The two numbers are a
 * pair: zero movement AND content on the first frame.
 */
import { expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";

export type ShiftSource = {
  node: string;
  from: { x: number; y: number; w: number; h: number };
  to: { x: number; y: number; w: number; h: number };
};
export type Shift = { value: number; at: number; sources: ShiftSource[] };

/**
 * WHEN THE SURFACE STOPPED BEING EMPTY, measured from two different starts.
 *
 * `ms` counts from `DOMContentLoaded`, which is the number the reader lives:
 * it includes downloading, parsing and booting the client bundle. It is
 * REPORTED, and it is not the gate - on a machine running a dozen agents that
 * boot alone swings from 40 ms to two seconds, so a budget hung on it fails or
 * passes depending on the load, which means it measures the machine.
 *
 * `afterShellMs` counts from the app's own FIRST PAINT (the root has a child).
 * That is the quantity this card is about: once React is running, is the pane
 * already full - drawn from the local copy - or does it still have to wait for
 * a fetch? The bundle boot cancels out of the subtraction, so the same number
 * comes back on an idle machine and on a loaded one.
 */
export type Fullness = {
  /** The selector that stands for "this pane drew something real". */
  selector: string;
  /** Milliseconds from `DOMContentLoaded`, or `null` if it never filled. */
  ms: number | null;
  /** Milliseconds from the app shell's first paint. THE GATE. */
  afterShellMs: number | null;
};

export type ClsReport = {
  cls: number;
  total: number;
  count: number;
  shifts: Shift[];
  fullness?: Fullness;
  /** Whatever the caller wants recorded next to the numbers (row heights, ...). */
  geometry?: unknown;
};

export const CLS_OUT_DIR = resolve(__dirname, "../../../test-results/cls");

/**
 * Registers the observer BEFORE the app. It lives on `window` because it has to
 * survive the reload as init code, not as state.
 */
export async function armObserver(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type LayoutShiftSource = { node?: Node | null; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly };
    type LayoutShift = PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: LayoutShiftSource[] };
    const shifts: unknown[] = [];
    (window as unknown as { __clsShifts: unknown[] }).__clsShifts = shifts;

    // What the node that moved is called. The testid first, because it is the
    // only name the code chose on purpose; then aria-label, id, and as a last
    // resort the first classes, which at least name the neighbourhood.
    const name1 = (el: Element): string => {
      const marker = el.getAttribute("data-testid");
      if (marker) return `${el.tagName.toLowerCase()}[data-testid=${marker}]`;
      const aria = el.getAttribute("aria-label");
      if (aria) return `${el.tagName.toLowerCase()}[aria-label="${aria}"]`;
      if (el.id) return `${el.tagName.toLowerCase()}#${el.id}`;
      const cls = (el.getAttribute("class") || "").split(/\s+/).filter(Boolean).slice(0, 3).join(".");
      return cls ? `${el.tagName.toLowerCase()}.${cls}` : el.tagName.toLowerCase();
    };
    // The node alone often says nothing ("div"): the first measurement blamed
    // 100% of the cost on an anonymous `div`, which is an attribution nobody can
    // act on. What is needed is the NEIGHBOURHOOD - the nearest ancestor
    // somebody named with a testid or an aria-label.
    const describe = (n: Node | null | undefined): string => {
      if (!n || !(n instanceof Element)) return "(non-element)";
      const el = n as Element;
      const chain: string[] = [name1(el)];
      let p: Element | null = el.parentElement;
      let named = el.hasAttribute("data-testid");
      for (let i = 0; i < 8 && p && !named; i++) {
        if (p.hasAttribute("data-testid") || p.hasAttribute("aria-label")) { chain.unshift(name1(p)); named = true; break; }
        p = p.parentElement;
      }
      if (!named && el.parentElement) chain.unshift(name1(el.parentElement));
      return chain.join(" » ");
    };
    const rect = (r: DOMRectReadOnly) => ({
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
    });

    new PerformanceObserver((list) => {
      for (const raw of list.getEntries()) {
        const e = raw as LayoutShift;
        if (e.hadRecentInput) continue;
        shifts.push({
          value: e.value,
          at: Math.round(e.startTime),
          sources: (e.sources || []).map((s) => ({
            node: describe(s.node),
            from: rect(s.previousRect),
            to: rect(s.currentRect),
          })),
        });
      }
    }).observe({ type: "layout-shift", buffered: true });

    // WHEN THE PAGE STOPPED DOING THINGS, so the observation can end on a
    // condition instead of on a stopwatch. Every request the reload fires
    // stamps its departure and its answer here; `settledUntilQuiet` then asks
    // for a stretch with no request and no shift in it. Only the START of a
    // stream is stamped, never its chunks: an SSE connection stays open for the
    // life of the page and would otherwise mean "never quiet".
    const marks = window as unknown as { __lastNetAt: number };
    marks.__lastNetAt = 0;
    const stamp = () => { marks.__lastNetAt = performance.now(); };
    const originalFetch = window.fetch.bind(window);
    window.fetch = ((...args: Parameters<typeof fetch>) => {
      stamp();
      return originalFetch(...args).then(
        (r) => { stamp(); return r; },
        (e) => { stamp(); throw e; },
      );
    }) as typeof fetch;
    const openXhr = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
      stamp();
      this.addEventListener("loadend", stamp);
      return (openXhr as unknown as (...a: unknown[]) => unknown).apply(this, args);
    } as typeof XMLHttpRequest.prototype.open;
  });
}

/**
 * THE END OF THE OBSERVATION IS A CONDITION, not a clock.
 *
 * This used to be `waitForTimeout(6000)`, and six seconds is a bet: too short
 * and a late fetch moves the page after nobody is looking, too long and every
 * pane pays for the worst case. The claim being tested is "everything this
 * reload asked for has arrived AND nothing moved because of it", so the wait
 * ends when both halves are true: the document is complete, no request has left
 * or landed for `quietMs`, and no layout shift has been recorded for `quietMs`.
 * A page that keeps answering keeps the window open by itself; a page that is
 * done is not watched for five more seconds out of superstition.
 */
export async function settledUntilQuiet(
  page: Page,
  opts?: { quietMs?: number; timeout?: number },
): Promise<void> {
  const quietMs = opts?.quietMs ?? 2000;
  await page.waitForFunction(
    (ms: number) => {
      if (document.readyState !== "complete") return false;
      const w = window as unknown as { __clsShifts?: Array<{ at: number }>; __lastNetAt?: number };
      const shifts = w.__clsShifts ?? [];
      const lastShift = shifts.length ? shifts[shifts.length - 1]!.at : 0;
      const last = Math.max(lastShift, w.__lastNetAt ?? 0);
      return performance.now() - last >= ms;
    },
    quietMs,
    { timeout: opts?.timeout ?? 20000, polling: 100 },
  );
}

/**
 * Watches ONE selector and records the instant it first has content, relative to
 * `DOMContentLoaded`.
 *
 * "Has content" is deliberately crude: a box with a non-zero area that contains
 * either a descendant element or some text. Anything finer would be a per-pane
 * rubric, and the question here is not "is it the right content" (the pane's own
 * spec asks that) but "was the reader looking at an empty rectangle".
 */
export async function armFullness(page: Page, selector: string): Promise<void> {
  await page.addInitScript((sel: string) => {
    const w = window as unknown as { __fullAt: number | null; __domReadyAt: number | null; __shellAt: number | null };
    w.__fullAt = null;
    w.__domReadyAt = null;
    w.__shellAt = null;
    const markReady = () => { if (w.__domReadyAt === null) w.__domReadyAt = performance.now(); };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", markReady, { once: true });
    else markReady();

    // The app's first paint: the moment React has put ANYTHING under the root.
    // Everything before it is the bundle arriving and booting - the machine's
    // share of the wait, which is not what this measures.
    const shellTick = () => {
      if (w.__shellAt !== null) return;
      const root = document.getElementById("root");
      if (root && root.childElementCount > 0) { w.__shellAt = performance.now(); return; }
      requestAnimationFrame(shellTick);
    };
    requestAnimationFrame(shellTick);

    const filled = (): boolean => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      return el.childElementCount > 0 || (el.textContent || "").trim().length > 0;
    };
    const tick = () => {
      if (w.__fullAt !== null) return;
      if (filled()) { w.__fullAt = performance.now(); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, selector);
}

/** The session windows of the web-vitals definition: 1s gap, 5s length. */
export function sessionCls(shifts: Shift[]): number {
  let best = 0, sum = 0, first = 0, prev = 0;
  for (const s of shifts) {
    if (sum && (s.at - prev > 1000 || s.at - first > 5000)) sum = 0;
    if (!sum) first = s.at;
    prev = s.at;
    sum += s.value;
    if (sum > best) best = sum;
  }
  return best;
}

/**
 * WAIT FOR THE LOCAL COPY, not for a clock.
 *
 * Every one of these measurements is about the frame drawn BEFORE any answer
 * arrives, so the state that decides the verdict is the snapshot in
 * `localStorage`. Reloading before it is written measures a first visit and
 * calls it a return. The condition is therefore the key itself: it is there, and
 * (when a needle is given) it carries the content the next frame has to draw.
 */
export async function waitForLocalCopy(page: Page, keyPrefix: string, needle?: string): Promise<void> {
  await expect
    .poll(
      async () =>
        await page.evaluate(
          ({ prefix, text }: { prefix: string; text?: string }) => {
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              if (!key || !key.startsWith(prefix)) continue;
              const value = localStorage.getItem(key) || "";
              if (value.length <= 2) continue;
              if (!text || value.includes(text)) return true;
            }
            return false;
          },
          { prefix: keyPrefix, text: needle },
        ),
      {
        timeout: 20000,
        message: `the local copy under "${keyPrefix}"${needle ? ` carrying "${needle}"` : ""} was never written`,
      },
    )
    .toBe(true);
}

export async function collectShifts(page: Page): Promise<Shift[]> {
  return await page.evaluate(
    () => (window as unknown as { __clsShifts?: Shift[] }).__clsShifts ?? [],
  ) as Shift[];
}

export async function collectFullness(page: Page, selector: string): Promise<Fullness> {
  const raw = await page.evaluate(() => {
    const w = window as unknown as { __fullAt?: number | null; __domReadyAt?: number | null; __shellAt?: number | null };
    return { full: w.__fullAt ?? null, ready: w.__domReadyAt ?? null, shell: w.__shellAt ?? null };
  });
  if (raw.full === null) return { selector, ms: null, afterShellMs: null };
  return {
    selector,
    ms: raw.ready === null ? null : Math.max(0, Math.round(raw.full - raw.ready)),
    afterShellMs: raw.shell === null ? null : Math.max(0, Math.round(raw.full - raw.shell)),
  };
}

/** The readable report: who moved and what it cost, most expensive first. */
export function summarize(report: { shifts: Shift[] }): string {
  const byNode = new Map<string, { value: number; hits: number }>();
  for (const s of report.shifts) {
    const names = s.sources.length ? s.sources.map((x) => x.node) : ["(no source)"];
    for (const n of names) {
      const cur = byNode.get(n) || { value: 0, hits: 0 };
      cur.value += s.value / names.length;
      cur.hits += 1;
      byNode.set(n, cur);
    }
  }
  return [...byNode.entries()]
    .sort((a, b) => b[1].value - a[1].value)
    .map(([n, v]) => `  ${v.value.toFixed(4)}  x${v.hits}  ${n}`)
    .join("\n");
}

/** Builds the report from the raw entries, so BEFORE and AFTER stay comparable. */
export function buildReport(shifts: Shift[], extra?: { fullness?: Fullness; geometry?: unknown }): ClsReport {
  return {
    cls: sessionCls(shifts),
    total: shifts.reduce((a, s) => a + s.value, 0),
    count: shifts.length,
    shifts,
    ...(extra?.fullness ? { fullness: extra.fullness } : {}),
    ...(extra?.geometry !== undefined ? { geometry: extra.geometry } : {}),
  };
}

/** One file per surface and viewport, so BEFORE and AFTER compare line by line. */
export function writeReport(label: string, name: string, report: ClsReport): string {
  mkdirSync(CLS_OUT_DIR, { recursive: true });
  const file = resolve(CLS_OUT_DIR, `${label}-${name}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
}
