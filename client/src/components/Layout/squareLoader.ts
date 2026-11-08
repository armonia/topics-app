/**
 * THE SQUARE LOADER ENGINE: up to 48 rounded squares that slide from one shape to the
 * next; the smallest bodies use only a few. A faithful port of the approved reference bench: same
 * shapes, same movements, same easing. Nothing here knows about React; the
 * component lives in `StreamingIndicator`.
 *
 * COST IS THE RISK: dozens of loaders run at once. So there is ONE clock
 * (`requestAnimationFrame`) shared by every body, bodies off screen are removed
 * from it, a window nobody is looking at stops it, and bodies under 24px step at 30 fps at
 * most. `prefers-reduced-motion` draws one still frame and never joins the clock.
 *
 * The colour is not here: the canvas is filled with the element's own
 * `currentColor`, so `loaderArcClass` keeps deciding it.
 */

import { isWindowAwake, onWindowAwakeChange } from '../../state/windowAwake';

export type LoaderActivity = 'rest' | 'think' | 'search' | 'write' | 'tool' | 'sync' | 'wait' | 'done' | 'error';

const TAU = Math.PI * 2;
/** Particles in a body. */
const PARTICLES = 48;
/** Floats per particle: x, y, alpha, size. */
const STRIDE = 4;
/** Under this size a body steps at most 30 times a second. */
const SMALL_PX = 24;
const SMALL_FRAME_MS = 1000 / 30;
/** A change of shape takes this long to settle (seconds). */
const SETTLE_S = 1;
/** How fast a small body follows its shape: slow while changing, tight once settled. Alpha keeps the slow pace. */
const RATE_FREE = 6.5;
/** A small body crosses cells: any faster and a point lands on the next cell in one frame. */
const RATE_SMALL_CHANGE = 4;
/** A change starts from standing: the pace ramps up over this long (seconds). */
const RAMP_S = 0.3;
const RATE_SETTLED = 10;

type Particle = [number, number, number, number];
type Shape = (t: number, n: number, pixel: boolean, age: number) => Particle[];

const KO_CELLS: Record<number, string[]> = {
  9: ['....#....', '....#....', '....#....', '....#....', '....#....', '.........', '....#....', '.........', '.........'],
};

function cells(rows: string[]): Particle[] {
  const n = rows.length;
  const out: Particle[] = [];
  rows.forEach((row, y) => [...row].forEach((c, x) => {
    if (c === '#') out.push([((x - (n - 1) / 2) / ((n - 1) / 2)) * 0.92, ((y - (n - 1) / 2) / ((n - 1) / 2)) * 0.92, 1, 1]);
  }));
  return out;
}

/** A low-resolution sphere: few points, tilted axis, slow turn. */
function orb(t: number, count: number, beam?: number): Particle[] {
  const out: Particle[] = [];
  const ct = Math.cos(0.42);
  const st = Math.sin(0.42);
  for (let i = 0; i < count; i++) {
    const y0 = 1 - (2 * (i + 0.5)) / count;
    const r = Math.sqrt(1 - y0 * y0);
    const a = i * 2.399 + t * 0.45;
    const x0 = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const x = x0 * ct - y0 * st;
    const y = x0 * st + y0 * ct;
    let al = 0.3 + (0.7 * (z + 1)) / 2;
    let sz = 0.65 + (0.45 * (z + 1)) / 2;
    if (beam !== undefined) {
      const lit = Math.max(0, 1 - Math.abs(x - beam) * 3.2) * (z > -0.2 ? 1 : 0.2);
      al = 0.14 + 0.86 * lit;
      sz = 0.6 + 0.7 * lit;
    }
    out.push([x * 0.88, y * 0.88, al, sz]);
  }
  return out;
}

function ring(n: number, radius: number, alphaAt: (u: number) => number): Particle[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * TAU;
    return [Math.cos(a) * radius, Math.sin(a) * radius, alphaAt(i / n), 1] as Particle;
  });
}

const SHAPES: Record<LoaderActivity, { hold: number; fn: Shape }> = {
  rest: {
    hold: 3.6,
    fn(t) {
      const out: Particle[] = [];
      for (let y = -1; y <= 1; y++) {
        for (let x = -1; x <= 1; x++) {
          const i = (y + 1) * 3 + x + 1;
          out.push([x * 0.3, y * 0.3, 0.28 + 0.72 * Math.pow(0.5 + 0.5 * Math.sin(t * (0.9 + i * 0.13) + i * 2.1), 2), 0.95]);
        }
      }
      return out;
    },
  },
  think: { hold: 3.2, fn: (t, n) => orb(t, n === 7 ? 14 : 30) },
  search: { hold: 3.2, fn: (t, n) => orb(t * 0.25, n === 7 ? 16 : 34, Math.sin(t * 2.2) * 0.95) },
  write: {
    hold: 3.2,
    fn(t, n) {
      const out: Particle[] = [];
      const rows = n === 7 ? 3 : 4;
      const w = n;
      const progress = (t * 5) % (rows * w + 4);
      const lengths = [1, 0.72, 0.92, 0.5];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < w * lengths[r]; c++) {
          const on = r * w + c < progress;
          out.push([((c - (w - 1) / 2) / ((w - 1) / 2)) * 0.92, (r - (rows - 1) / 2) * (n === 7 ? 0.6 : 0.46), on ? 1 : 0.1, on ? 1 : 0.8]);
        }
      }
      return out;
    },
  },
  tool: {
    hold: 3.2,
    fn(t, n) {
      const out: Particle[] = [];
      const k = n === 7 ? 6 : 9;
      [[0, 0.95, 0.5], [1.05, 0.95, 0.5], [2.1, 0.95, 0.5]].forEach((q, j) => {
        for (let i = 0; i < k; i++) {
          const a = t * (1.5 + j * 0.3) + i * 0.22 + j * 2;
          const x = Math.cos(a) * q[1];
          const y = Math.sin(a) * q[2];
          const c = Math.cos(q[0]);
          const s = Math.sin(q[0]);
          out.push([x * c - y * s, x * s + y * c, 1 - i / k, 0.9 - i * 0.05]);
        }
      });
      return out;
    },
  },
  sync: {
    hold: 3.2,
    fn(t, n) {
      const head = (t * 0.55) % 1;
      return ring(n === 7 ? 12 : 20, 0.86, (u) => {
        const d = Math.min((u - head + 1) % 1, (u - head + 0.5 + 1) % 1);
        return Math.max(0.1, 1 - d * 3.4);
      });
    },
  },
  wait: {
    hold: 3.2,
    fn(t, n) {
      const b = 0.72 + 0.14 * Math.sin(t * 2.2);
      return ring(n === 7 ? 10 : 16, b, () => 0.55 + 0.45 * Math.sin(t * 2.2));
    },
  },
  done: {
    hold: 2.4,
    fn(_t, _n, _pixel, age) {
      // Geometric tick: two strokes at 45 degrees, equal-step squares, drawn from the bottom left.
      const P = [[-0.66, 0.04], [-0.2, 0.5], [0.68, -0.38]];
      const step = 0.217;
      const l1 = Math.hypot(P[1][0] - P[0][0], P[1][1] - P[0][1]);
      const l2 = Math.hypot(P[2][0] - P[1][0], P[2][1] - P[1][1]);
      const k = Math.round((l1 + l2) / step);
      const out: Particle[] = [];
      for (let i = 0; i <= k; i++) {
        const d = ((l1 + l2) * i) / k;
        const on = age * 16 > i ? 1 : 0;
        const q = d <= l1 ? d / l1 : (d - l1) / l2;
        const A = d <= l1 ? P[0] : P[1];
        const B = d <= l1 ? P[1] : P[2];
        out.push([A[0] + (B[0] - A[0]) * q, A[1] + (B[1] - A[1]) * q, on, 1]);
      }
      return out;
    },
  },
  error: {
    hold: 2.2,
    fn(t, n) {
      const shake = Math.sin(t * 22) * 0.035 * Math.max(0, 1 - (t % 3) * 2.5);
      return cells(KO_CELLS[n]).map((p) => [p[0] + shake, p[1], p[2], p[3]] as Particle);
    },
  },
};

/** Three squares across, on every whole cell of the small body. */
const THREE = [-1, 0, 1];

function threeByThree(sizeAt: (x: number, y: number, i: number) => number): Particle[] {
  return THREE.flatMap((y, r) => THREE.map((x, c) => [x, y, 1, sizeAt(x, y, r * 3 + c)] as Particle));
}

/** A line of touching squares: at small sizes they merge into one clean stroke. */
function stroke(points: number[][], count: number, size: number): Particle[] {
  return Array.from({ length: count }, (_, i) => {
    const u = (i / (count - 1)) * (points.length - 1);
    const k = Math.min(points.length - 2, Math.floor(u));
    const q = u - k;
    return [points[k][0] + (points[k + 1][0] - points[k][0]) * q, points[k][1] + (points[k + 1][1] - points[k][1]) * q, 1, size] as Particle;
  });
}

/**
 * THE SHAPES UP TO 16PX. At that size a dozen squares cannot exist: there is no room, they blur into
 * a smudge. So few large squares, always at full ink: what moves is their place and their size.
 * A 20px body keeps the fine shapes and borrows only the two signs, drawn as a thicker, denser stroke.
 */
const SMALL_SHAPES: Record<LoaderActivity, Shape> = {
  rest: (t) => threeByThree((_x, _y, i) => 0.6 + 0.4 * Math.sin(t * (0.9 + i * 0.13) + i * 2.1) ** 2),
  think: (t) => Array.from({ length: 4 }, (_, i) => {
    const a = t * 1.5 + (i * TAU) / 4;
    return [Math.cos(a) * 0.86, Math.sin(a) * 0.86, 1, 0.62 + 0.38 * (0.5 + 0.5 * Math.sin(a))] as Particle;
  }),
  search: (t) => {
    const beam = Math.sin(t * 2.2) * 1.15;
    return threeByThree((x) => 0.4 + 0.6 * Math.max(0, 1 - Math.abs(x - beam) * 1.3));
  },
  write: (t) => {
    const progress = (t * 3.2) % 11;
    return threeByThree((_x, _y, i) => (i < progress ? 1 : 0.4)).slice(0, 8);
  },
  tool: (t) => Array.from({ length: 3 }, (_, i) => {
    const a = t * 3.6 - i * 1.05;
    return [Math.cos(a) * 0.92, Math.sin(a) * 0.92, 1, 1 - i * 0.28] as Particle;
  }),
  sync: (t) => [0, 1].map((i) => {
    const a = t * 2.6 + i * Math.PI;
    return [Math.cos(a) * 0.9, Math.sin(a) * 0.9, 1, 1] as Particle;
  }),
  wait: (t) => {
    const b = 0.5 + 0.5 * Math.sin(t * 2.2);
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => [x * (0.62 + 0.3 * b), y * (0.62 + 0.3 * b), 1, 0.8 + 0.2 * b] as Particle);
  },
  done: (_t, n) => stroke([[-1, 0.02], [-0.32, 0.72], [1, -0.72]], n === 7 ? 16 : 9, n === 7 ? 1.1 : 0.62),
  error: (t, n) => {
    const shake = Math.sin(t * 22) * 0.05 * Math.max(0, 1 - (t % 3) * 2.5);
    return [...stroke([[0, -1], [0, 0.32]], n === 7 ? 8 : 4, n === 7 ? 1.1 : 0.62), [0, 1, 1, n === 7 ? 1.2 : 0.66]].map((p) => [p[0] + shake, p[1], p[2], p[3]] as Particle);
  },
};

/** The minimal canvas surface the body draws on, so a test can count calls. */
export interface LoaderContext {
  clearRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  roundRect(x: number, y: number, w: number, h: number, r: number): void;
  fill(): void;
  fillStyle: string | CanvasGradient | CanvasPattern;
  globalAlpha: number;
}

export class LoaderBody {
  private readonly pos = new Float32Array(PARTICLES * STRIDE);
  private readonly mapping = new Int16Array(PARTICLES);
  private mapLen = -1;
  private activity: LoaderActivity | null = null;
  private since = 0;
  /** 0 right after a change of shape, 1 once settled. */
  private settled = 0;
  /** Last time this body stepped (seconds), for dt and the 30 fps cap. */
  lastStep = -1;
  readonly pixel: boolean;
  readonly grid: 7 | 9;
  /** Up to 16px: few large squares on whole device pixels. */
  readonly tiny: boolean;
  /** Pixel density the canvas was sized for. */
  readonly scale: number;

  constructor(
    readonly size: number,
    private readonly ctx: LoaderContext,
    opts: { scale?: number; hollow?: boolean } = {},
  ) {
    this.scale = opts.scale ?? 1;
    this.pixel = size <= 20;
    this.grid = this.pixel ? 7 : 9;
    this.tiny = size <= 16;
    this.hollow = !!opts.hollow && this.pixel && !this.tiny;
    // A new body grows out of its centre: full ink, no size.
    for (let j = 0; j < PARTICLES; j++) this.pos[j * STRIDE + 2] = 1;
  }

  /** Particles sit on the border of the grid, the centre stays free (the tab number sits there). */
  private readonly hollow: boolean;

  get minFrameMs(): number {
    // The cap saves work on a settled body; a change of shape gets every frame, that is what makes it fluid.
    return this.size < SMALL_PX && this.settled >= 1 ? SMALL_FRAME_MS : 0;
  }

  private target(activity: LoaderActivity, t: number, cache?: Map<string, Particle[]>): Particle[] {
    const sign = activity === 'done' || activity === 'error';
    const shape = this.tiny || (this.pixel && sign) ? SMALL_SHAPES[activity] : SHAPES[activity].fn;
    let raw: Particle[];
    if (activity === 'done' && !this.pixel) {
      raw = shape(t, this.grid, this.pixel, Math.max(0, t - this.since));
    } else {
      // The tiny flag is part of the key: 16px and 20px bodies share a grid but not their shapes.
      const key = `${activity}|${this.grid}|${this.pixel}|${this.tiny}`;
      raw = cache?.get(key) ?? shape(t, this.tiny ? 3 : this.grid, this.pixel, 0);
      cache?.set(key, raw);
    }
    raw = raw.length > PARTICLES ? raw.slice(0, PARTICLES) : raw;
    if (!this.hollow) return raw;
    // Push every point out onto the border of the square, so none lands in the centre.
    return raw.map((p) => {
      const m = Math.max(Math.abs(p[0]), Math.abs(p[1]));
      if (m < 1e-3) return [0, 0, p[2], 0] as Particle;
      return [(p[0] / m) * 0.92, (p[1] / m) * 0.92, p[2], p[3]] as Particle;
    });
  }

  /** Each point of a new shape takes the nearest free square: no crossings, the shape never flips. */
  private assign(raw: Particle[]): void {
    const free = new Set<number>();
    for (let j = 0; j < PARTICLES; j++) free.add(j);
    this.mapping.fill(-1);
    raw.forEach((g, i) => {
      let best = -1;
      let bd = 1e9;
      free.forEach((j) => {
        const b = j * STRIDE;
        const d = (this.pos[b] - g[0]) ** 2 + (this.pos[b + 1] - g[1]) ** 2 + (this.pos[b + 3] < 0.05 ? 0.5 : 0);
        if (d < bd) { bd = d; best = j; }
      });
      free.delete(best);
      this.mapping[best] = i;
    });
    // The squares left over never fade: each one shrinks away into its nearest neighbour.
    free.forEach((j) => {
      const b = j * STRIDE;
      let near = 0;
      let nd = 1e9;
      raw.forEach((g, i) => {
        const d = (this.pos[b] - g[0]) ** 2 + (this.pos[b + 1] - g[1]) ** 2;
        if (d < nd) { nd = d; near = i; }
      });
      this.mapping[j] = -1 - near;
    });
    this.mapLen = raw.length;
  }

  step(activity: LoaderActivity, t: number, dt: number, cache?: Map<string, Particle[]>): void {
    if (this.activity !== activity) { this.activity = activity; this.since = t; this.mapLen = -1; }
    const raw = this.target(activity, t, cache);
    if (this.mapLen !== raw.length) this.assign(raw);
    const age = t - this.since;
    this.settled = Math.min(1, age / SETTLE_S);
    const ramp = Math.min(1, age / RAMP_S);
    const pace = this.pixel ? RATE_SMALL_CHANGE + (RATE_SETTLED - RATE_SMALL_CHANGE) * this.settled ** 4 : RATE_FREE;
    const posRate = 1 - Math.exp(-dt * pace * ramp * ramp);
    const alphaRate = 1 - Math.exp(-dt * RATE_SMALL_CHANGE);
    for (let j = 0; j < PARTICLES; j++) {
      const b = j * STRIDE;
      const i = this.mapping[j];
      const leaving = i < 0;
      const g = raw[leaving ? -1 - i : i];
      for (let k = 0; k < STRIDE; k++) {
        const goal = !g || (leaving && k === 2) ? this.pos[b + k] : leaving && k === 3 ? 0 : g[k];
        this.pos[b + k] += (goal - this.pos[b + k]) * (k === 2 ? alphaRate : posRate);
      }
    }
  }

  /** Jump straight to the shape of `activity` (the reduced-motion still frame). */
  snap(activity: LoaderActivity, t: number): void {
    this.step(activity, t, 0);
    // Past the ramp, or a body that has just changed shape would not move at all.
    this.since = t - SETTLE_S;
    this.step(activity, t, 10);
    this.settled = 1;
  }

  draw(color: string): void {
    const c = this.ctx;
    const W = this.size * this.scale;
    c.clearRect(0, 0, W, W);
    c.fillStyle = color;
    const pos = this.pos;
    // The tiniest bodies sit on whole device pixels: an edge between two pixels reads as a smudge there.
    const tiny = this.tiny;
    const base = tiny ? Math.round(W * 0.27) : this.pixel ? (W / this.grid) * 0.74 : (W / 9) * 0.58;
    const R = this.pixel ? W / 2 - base / 2 : W * 0.4;
    for (let j = 0; j < PARTICLES; j++) {
      const b = j * STRIDE;
      const q = tiny ? Math.round(base * pos[b + 3]) : base * pos[b + 3];
      if (pos[b + 2] < 0.02 || q < (tiny ? 1 : 0.25)) continue;
      // A fine body reads too faint at its true light.
      c.globalAlpha = this.pixel ? Math.sqrt(Math.min(1, pos[b + 2])) : Math.min(1, pos[b + 2]);
      const x = W / 2 + pos[b] * R - q / 2;
      const y = W / 2 + pos[b + 1] * R - q / 2;
      c.beginPath();
      c.roundRect(tiny ? Math.round(x) : x, tiny ? Math.round(y) : y, q, q, q * 0.28);
      c.fill();
    }
    c.globalAlpha = 1;
  }
}

/** What the clock needs from a body's owner. */
export interface ClockClient {
  body: LoaderBody;
  activity: () => LoaderActivity;
  color: () => string;
}

export interface ClockEnv {
  raf: (cb: (ms: number) => void) => number;
  cancel: (id: number) => void;
  hidden: () => boolean;
}

/** Counters a test (and the dev tools) read. */
interface ClockStats { frames: number; draws: number; }

/**
 * ONE clock for every loader. It runs only while at least one client is
 * registered and the window is visible; a hidden window cancels the pending
 * frame, so there are no draws at all until it comes back.
 */
export function createLoaderClock(env: ClockEnv) {
  const clients = new Set<ClockClient>();
  const stats: ClockStats = { frames: 0, draws: 0 };
  let id = 0;
  let last = 0;

  const loop = (ms: number): void => {
    id = 0;
    if (clients.size === 0 || env.hidden()) return;
    const t = ms / 1000;
    const dt = Math.min(0.05, t - last || 0.016);
    last = t;
    stats.frames++;
    const cache = new Map<string, Particle[]>();
    clients.forEach((cl) => {
      const b = cl.body;
      if (b.minFrameMs && b.lastStep >= 0 && ms - b.lastStep < b.minFrameMs - 2) return;
      const own = b.lastStep >= 0 ? Math.min(0.05, (ms - b.lastStep) / 1000) : dt;
      b.lastStep = ms;
      b.step(cl.activity(), t, own, cache);
      b.draw(cl.color());
      stats.draws++;
    });
    id = env.raf(loop);
  };

  const wake = (): void => {
    if (id || clients.size === 0 || env.hidden()) return;
    last = 0;
    id = env.raf(loop);
  };

  return {
    stats,
    add(cl: ClockClient): void { cl.body.lastStep = -1; clients.add(cl); wake(); },
    remove(cl: ClockClient): void {
      clients.delete(cl);
      if (clients.size === 0 && id) { env.cancel(id); id = 0; }
    },
    /** Call on `visibilitychange`: stops on hidden, restarts on visible. */
    visibilityChanged(): void {
      if (env.hidden()) { if (id) { env.cancel(id); id = 0; } } else wake();
    },
    size: () => clients.size,
  };
}

let shared: ReturnType<typeof createLoaderClock> | null = null;

/** The app's clock, created on first use in a browser. */
export function sharedLoaderClock(): ReturnType<typeof createLoaderClock> {
  if (!shared) {
    shared = createLoaderClock({
      raf: (cb) => requestAnimationFrame(cb),
      cancel: (n) => cancelAnimationFrame(n),
      // Not `document.hidden`: with the app behind another one it is false, and we would draw for nobody.
      hidden: () => !isWindowAwake(),
    });
    onWindowAwakeChange(() => shared?.visibilityChanged());
  }
  return shared;
}
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala
