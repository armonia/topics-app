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
import type { Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";

export type ShiftSource = {
  node: string;
  from: { x: number; y: number; w: number; h: number };
  to: { x: number; y: number; w: number; h: number };
};
export type Shift = { value: number; at: number; sources: ShiftSource[] };

/** How long after `DOMContentLoaded` the watched surface first had content. */
export type Fullness = {
  /** The selector that stands for "this pane drew something real". */
  selector: string;
  /** Milliseconds from `DOMContentLoaded`, or `null` if it never filled. */
  ms: number | null;
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
      const testid = el.getAttribute("data-testid");
      if (testid) return `${el.tagName.toLowerCase()}[data-testid=${testid}]`;
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
  });
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
    const w = window as unknown as { __fullAt: number | null; __domReadyAt: number | null };
    w.__fullAt = null;
    w.__domReadyAt = null;
    const markReady = () => { if (w.__domReadyAt === null) w.__domReadyAt = performance.now(); };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", markReady, { once: true });
    else markReady();

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

export async function collectShifts(page: Page): Promise<Shift[]> {
  return await page.evaluate(
    () => (window as unknown as { __clsShifts?: Shift[] }).__clsShifts ?? [],
  ) as Shift[];
}

export async function collectFullness(page: Page, selector: string): Promise<Fullness> {
  const raw = await page.evaluate(() => {
    const w = window as unknown as { __fullAt?: number | null; __domReadyAt?: number | null };
    return { full: w.__fullAt ?? null, ready: w.__domReadyAt ?? null };
  });
  if (raw.full === null || raw.ready === null) return { selector, ms: null };
  return { selector, ms: Math.max(0, Math.round(raw.full - raw.ready)) };
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
