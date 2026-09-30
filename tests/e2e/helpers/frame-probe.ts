/**
 * FRAME PROBE - what the screen showed, one row per animation frame.
 *
 * The motion contracts of the pane-loading specs are statements about FRAMES:
 * "the columns never moved", "the spinner was never the only thing on screen",
 * "the drawer arrived with an opacity below 1". A final-state assertion cannot
 * see any of them, because every defect they describe lasts one to twenty
 * frames and ends in the right place. So the probe samples the watched
 * elements on every `requestAnimationFrame`, from the first frame of the
 * document, and the spec reads the rows back between two marks.
 *
 * Per watched key and per frame it records the bounding rect, the EFFECTIVE
 * opacity (the product of the element and every ancestor, because a fade can
 * sit on a wrapper), a node identity (so a remount reads as a new id) and the
 * animations running on the element or its subtree, reduced to property,
 * duration and easing.
 *
 * It installs through `addInitScript`, so it runs before the app's first line
 * and costs the page a few `querySelector` calls per frame.
 */
import type { Page } from "@playwright/test";

export type ElSample = {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Effective opacity: element times every ancestor. */
  op: number;
  /** Stable per DOM node: a different id at the same key is a remount. */
  id: number;
};

export type Frame = { t: number; els: Record<string, ElSample | null> };

export type AnimationRecord = {
  key: string;
  t: number;
  kind: string;
  props: string[];
  duration: number;
  easing: string;
  /** -1 for a looping animation (a spinner), else the iteration count. */
  iterations: number;
};

export type Watch = Record<string, string>;

declare global {
  interface Window {
    __fp?: {
      watch: Watch;
      frames: Frame[];
      marks: Array<[number, string]>;
      animations: AnimationRecord[];
    };
  }
}

function probeSource(watch: Watch): string {
  return `(() => {
    const fp = { watch: ${JSON.stringify(watch)}, frames: [], marks: [], animations: [] };
    window.__fp = fp;
    const ids = new WeakMap();
    let next = 1;
    const seen = new WeakSet();
    const idOf = (el) => { let v = ids.get(el); if (!v) { v = next++; ids.set(el, v); } return v; };
    const opacityOf = (el) => {
      let op = 1;
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) op *= Number(getComputedStyle(n).opacity || 1);
      return Math.round(op * 1000) / 1000;
    };
    const describe = (a) => {
      const timing = a.effect && a.effect.getTiming ? a.effect.getTiming() : {};
      let props = [];
      if (a.transitionProperty) props = [a.transitionProperty];
      else if (a.effect && a.effect.getKeyframes) {
        const set = new Set();
        for (const k of a.effect.getKeyframes()) for (const p of Object.keys(k)) if (!['offset', 'easing', 'composite', 'computedOffset'].includes(p)) set.add(p);
        props = [...set];
      }
      let easing = timing.easing || '';
      if (a.animationName && a.effect && a.effect.getKeyframes) {
        const k = a.effect.getKeyframes()[0];
        if (k && k.easing) easing = k.easing;
      }
      const it = timing.iterations;
      return { kind: a.constructor ? a.constructor.name : 'Animation', props, duration: Number(timing.duration) || 0, easing, iterations: it === Infinity ? -1 : Number(it ?? 1) };
    };
    const tick = () => {
      const t = performance.now();
      const els = {};
      for (const [key, sel] of Object.entries(fp.watch)) {
        const el = document.querySelector(sel);
        if (!el) { els[key] = null; continue; }
        const r = el.getBoundingClientRect();
        els[key] = { x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10, op: opacityOf(el), id: idOf(el) };
        if (el.getAnimations) {
          for (const a of el.getAnimations({ subtree: true })) {
            if (seen.has(a)) continue;
            seen.add(a);
            fp.animations.push({ key, t, ...describe(a) });
          }
        }
      }
      fp.frames.push({ t, els });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })();`;
}

/** Install before `page.goto`: the probe must see the first frame. */
export async function armFrameProbe(page: Page, watch: Watch): Promise<void> {
  await page.addInitScript(probeSource(watch));
}

/** Replace the watched set on a live page (samples keep their history). */
export async function setWatch(page: Page, watch: Watch): Promise<void> {
  await page.evaluate((w) => { if (window.__fp) window.__fp.watch = w; }, watch);
}

/** Stamp a label on the timeline; returns its `performance.now()`. */
export async function markFrame(page: Page, label: string): Promise<number> {
  return page.evaluate((l) => {
    const t = performance.now();
    window.__fp?.marks.push([t, l]);
    return t;
  }, label);
}

/** Wait for `n` real animation frames. Pacing, not sleeping. */
export async function nextFrames(page: Page, n: number): Promise<void> {
  await page.evaluate((k) => new Promise<void>((done) => {
    let i = 0;
    const step = () => (++i >= k ? done() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  }), n);
}

export type Timeline = { frames: Frame[]; animations: AnimationRecord[] };

/**
 * The rows between the `from` mark and the `to` mark (or now). `from` may be
 * `null` for "since the first frame of the document".
 */
export async function readTimeline(page: Page, from: string | null, to?: string): Promise<Timeline> {
  return page.evaluate(({ f, e }) => {
    const fp = window.__fp;
    if (!fp) return { frames: [], animations: [] };
    const at = (l: string) => fp.marks.find((m) => m[1] === l)?.[0];
    const t0 = f === null ? -Infinity : at(f) ?? -Infinity;
    const t1 = e ? at(e) ?? Infinity : Infinity;
    return {
      frames: fp.frames.filter((x) => x.t >= t0 && x.t <= t1),
      animations: fp.animations.filter((x) => x.t >= t0 && x.t <= t1),
    };
  }, { f: from, e: to });
}

/** The samples of one key, only on frames where it was present with a size. */
export function presentSamples(tl: Timeline, key: string): Array<ElSample & { t: number }> {
  const out: Array<ElSample & { t: number }> = [];
  for (const f of tl.frames) {
    const s = f.els[key];
    if (s && s.w > 0 && s.h > 0) out.push({ ...s, t: f.t });
  }
  return out;
}

/** Largest frame-to-frame step of one edge of a key (px). */
export function maxStep(samples: Array<ElSample>, edge: "x" | "y" | "w" | "h"): number {
  let worst = 0;
  for (let i = 1; i < samples.length; i++) worst = Math.max(worst, Math.abs(samples[i][edge] - samples[i - 1][edge]));
  return worst;
}

/** The token durations of `client/src/lib/motion.ts`. */
export const MOTION_TOKENS = [90, 150, 240, 400];
