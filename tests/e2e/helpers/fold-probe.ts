/**
 * The frame sampler of `chat-accordion-no-shift.spec.ts`: where a clicked fold
 * header, the row above it and the fold itself are painted, read in the last
 * callback before every paint, and what counts as a shift in those frames.
 */
import type { Page } from "@playwright/test";

export type Frame = {
  t: number;
  st: number;
  sh: number;
  ch: number;
  hy: number | null;
  hx: number | null;
  ay: number | null;
  fh: number | null;
};
export type Probe = { frames: Frame[]; running: boolean; spec: { header: string; fold: string; docked: boolean } | null };

/**
 * A target is `css` (inside the visible chat pane) or `msg:<text>|<css>` (inside
 * the message row whose text contains <text>).
 */
export async function installProbe(page: Page) {
  await page.addInitScript(() => {
    const p: Probe = { frames: [], running: false, spec: null };
    (window as unknown as { __acc: Probe }).__acc = p;
    const r1 = (n: number) => Math.round(n * 10) / 10;
    const visiblePane = (): Element | null => {
      for (const area of document.querySelectorAll('[data-testid="chat-input-area"]')) {
        const r = area.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && area.parentElement) return area.parentElement;
      }
      return null;
    };
    const find = (root: Element | null, target: string): Element | null => {
      if (!root) return null;
      if (!target.startsWith("msg:")) return root.querySelector(target);
      const [text, css] = target.slice(4).split("|");
      const row = [...root.querySelectorAll('[data-testid="chat-message"]')].find((m) => (m.textContent ?? "").includes(text!));
      return row ? (css ? row.querySelector(css) : row) : null;
    };
    const sample = () => {
      const spec = p.spec;
      const root = visiblePane();
      const sc = root?.querySelector<HTMLElement>("[data-virtuoso-scroller]") ?? null;
      const header = spec ? find(root, spec.header) : null;
      const fold = spec ? find(root, spec.fold) : null;
      const rows = root ? [...root.querySelectorAll('[data-testid="chat-message"]')] : [];
      let above: Element | null = null;
      if (header && sc) {
        const scTop = sc.getBoundingClientRect().top;
        const scBottom = sc.getBoundingClientRect().bottom;
        if (spec!.docked) {
          // The last row of the transcript still on screen above the strip.
          const limit = header.getBoundingClientRect().top;
          above = rows.filter((m) => {
            const r = m.getBoundingClientRect();
            return r.height > 0 && r.top >= scTop && r.top < Math.min(limit, scBottom);
          }).pop() ?? null;
        } else {
          const own = header.closest('[data-testid="chat-message"]');
          const idx = own ? rows.indexOf(own) : -1;
          above = idx > 0 ? rows[idx - 1]! : null;
          if (above && above.getBoundingClientRect().bottom < scTop) above = null;
        }
      }
      const hr = header?.getBoundingClientRect();
      p.frames.push({
        t: performance.now(),
        st: sc ? r1(sc.scrollTop) : -1,
        sh: sc ? sc.scrollHeight : -1,
        ch: sc ? sc.clientHeight : -1,
        hy: hr && hr.height > 0 ? r1(hr.top) : null,
        hx: hr && hr.height > 0 ? r1(hr.left) : null,
        ay: above ? r1(above.getBoundingClientRect().top) : null,
        fh: fold ? r1(fold.getBoundingClientRect().height) : null,
      });
    };
    // Sampled in a ResizeObserver callback on a marker resized every frame:
    // after layout, before paint, after the app's own observers (created
    // earlier). What it reads is what is painted (see chat-transcript-motion).
    let marker: HTMLElement | null = null;
    const tick = () => {
      if (p.running && marker) marker.style.width = marker.style.width === "2px" ? "1px" : "2px";
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    let observer: ResizeObserver | null = null;
    const arm = () => {
      observer?.disconnect();
      marker?.remove();
      marker = document.createElement("div");
      marker.setAttribute("aria-hidden", "true");
      marker.style.cssText = "position:fixed;left:-10px;top:-10px;width:1px;height:1px;pointer-events:none";
      document.body.appendChild(marker);
      observer = new ResizeObserver(() => { if (p.running) sample(); });
      observer.observe(marker);
    };
    (window as unknown as { __accArm: () => void }).__accArm = arm;
    // Observers run in the order they were created. The app may create one
    // of its own in the click handler (the fold's hold), so the sampler is
    // created again right after every click, in the bubble phase on window,
    // which runs after React's handler: it stays the last code before paint.
    window.addEventListener("click", () => { if (p.running) arm(); });
  });
}

export async function startProbe(page: Page, spec: Probe["spec"]) {
  await page.evaluate((s) => {
    if (s && s.header.includes(";;")) {
      // `A;;B`: the fold's own header when it is in sight, else the control
      // under the body (a long code block folded from its end).
      const [a, b] = s.header.split(";;");
      const pane = [...document.querySelectorAll('[data-testid="chat-input-area"]')].find((x) => x.getBoundingClientRect().height > 0)?.parentElement;
      const sc = pane?.querySelector("[data-virtuoso-scroller]");
      const find = (t: string) => {
        if (!t.startsWith("msg:")) return pane?.querySelector(t) ?? null;
        const [text, css] = t.slice(4).split("|");
        const row = [...(pane?.querySelectorAll('[data-testid="chat-message"]') ?? [])].find((m) => (m.textContent ?? "").includes(text!));
        return row && css ? row.querySelector(css) : row ?? null;
      };
      const el = find(a!);
      s.header = el && sc && el.getBoundingClientRect().top >= sc.getBoundingClientRect().top ? a! : b!;
    }
    const p = (window as unknown as { __acc: Probe }).__acc;
    p.frames = []; p.spec = s; p.running = true;
    (window as unknown as { __accArm: () => void }).__accArm();
  }, spec);
}

export async function stopProbe(page: Page): Promise<Frame[]> {
  return page.evaluate(() => {
    const p = (window as unknown as { __acc: Probe }).__acc;
    p.running = false;
    return JSON.parse(JSON.stringify(p.frames)) as Frame[];
  });
}

export const frameCount = (page: Page) => page.evaluate(() => (window as unknown as { __acc: Probe }).__acc.frames.length);

/** Waits until the last `n` sampled frames show the view and the header still. */
export async function waitStill(page: Page, n = 12) {
  await page.waitForFunction((k) => {
    const f = (window as unknown as { __acc: Probe }).__acc.frames.slice(-k);
    return f.length === k && f.every((x) => x.st === f[0]!.st && x.sh === f[0]!.sh && x.hy === f[0]!.hy && x.fh === f[0]!.fh);
  }, n, { timeout: 20_000 });
}

/** Lets the sampler run until `ms` have passed since frame `from`. */
export async function sampleFor(page: Page, from: number, ms: number) {
  await page.waitForFunction(({ i, d }) => {
    const f = (window as unknown as { __acc: Probe }).__acc.frames;
    return f.length > i + 2 && f[f.length - 1]!.t - f[i]!.t >= d;
  }, { i: from, d: ms }, { timeout: 30_000 });
}

/**
 * Distinct runs of change of the fold's height in one direction. An animation
 * or an instant reveal is ONE run; a body that shows a placeholder and then
 * its real content is two. A run may pause for a couple of frames (a busy
 * frame, the slow tail of an easing curve) and stays one; runs under 4 px
 * are rounding, not content.
 */
function heightRuns(hs: number[], sign: 1 | -1): number {
  const PAUSE_FRAMES = 2;
  let runs = 0;
  let total = 0;
  let pause = 0;
  let inRun = false;
  const close = () => { if (inRun && total > 4) runs++; inRun = false; total = 0; pause = 0; };
  for (let i = 1; i < hs.length; i++) {
    const d = (hs[i]! - hs[i - 1]!) * sign;
    if (d > 0.5) { inRun = true; total += d; pause = 0; continue; }
    if (d < -0.5) { close(); continue; }
    if (inRun && ++pause > PAUSE_FRAMES) close();
  }
  close();
  return runs;
}

export type Measure = {
  kind: string;
  where: "bottom" | "middle";
  phase: "open" | "close";
  frames: number;
  headerJump: number;
  aboveJump: number;
  sideJump: number;
  foldRuns: number;
  foldDelta: number;
  headerLost: boolean;
};

export function measure(kind: string, where: Measure["where"], phase: Measure["phase"], frames: Frame[], clickAt: number): Measure {
  const base = frames[clickAt - 1]!;
  const after = frames.slice(clickAt);
  const max = (xs: number[]) => xs.reduce((m, x) => Math.max(m, x), 0);
  const hs = [base, ...after].map((f) => f.fh ?? 0);
  return {
    kind,
    where,
    phase,
    frames: after.length,
    headerLost: after.some((f) => f.hy === null),
    headerJump: base.hy === null ? Infinity : max(after.filter((f) => f.hy !== null).map((f) => Math.abs(f.hy! - base.hy!))),
    aboveJump: base.ay === null ? 0 : max(after.filter((f) => f.ay !== null).map((f) => Math.abs(f.ay! - base.ay!))),
    sideJump: base.hx === null ? 0 : max(after.filter((f) => f.hx !== null).map((f) => Math.abs(f.hx! - base.hx!))),
    foldRuns: heightRuns(hs, phase === "open" ? 1 : -1),
    foldDelta: Math.round(((after[after.length - 1]?.fh ?? 0) - (base.fh ?? 0)) * 10) / 10,
  };
}

export function faults(m: Measure, docked: boolean): string[] {
  const out: string[] = [];
  const at = `${m.kind} ${m.where} ${m.phase}`;
  if (m.headerLost) out.push(`${at}: the header left the DOM`);
  if (m.headerJump > 1) out.push(`${at}: the clicked header moved ${m.headerJump}px`);
  // A docked list opened at the bottom pushes the followed transcript up
  // with it: that row moving is the point (`newestRowCovered` checks it).
  if (m.aboveJump > 1 && !(docked && m.where === "bottom")) out.push(`${at}: the row above moved ${m.aboveJump}px`);
  if (m.sideJump > 1) out.push(`${at}: the header moved ${m.sideJump}px sideways`);
  if (!docked && m.foldRuns > 1) out.push(`${at}: the fold changed height in ${m.foldRuns} separate runs (a reveal that pops)`);
  return out;
}
