/**
 * THE SQUARE LOADER ENGINE: 48 rounded squares that slide from one shape to the
 * next. A faithful port of the approved reference bench: same
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

type Particle = [number, number, number, number];
type Shape = (t: number, n: number, pixel: boolean, age: number) => Particle[];

const OK_CELLS: Record<number, string[]> = {
  7: ['.......', '......#', '.....#.', '#...#..', '.#.#...', '..#....', '.......'],
  9: ['.........', '.........', '........#', '.......#.', '#.....#..', '.#...#...', '..#.#....', '...#.....', '.........'],
};
const KO_CELLS: Record<number, string[]> = {
  7: ['...#...', '...#...', '...#...', '...#...', '.......', '...#...', '.......'],
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
    fn(_t, n, pixel, age) {
      if (pixel) return cells(OK_CELLS[n]);
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
  /** Last time this body stepped (seconds), for dt and the 30 fps cap. */
  lastStep = -1;
  readonly pixel: boolean;
  readonly grid: 7 | 9;
  /** Pixel density the canvas was sized for. */
  readonly scale: number;

  constructor(
    readonly size: number,
    private readonly ctx: LoaderContext,
    opts: { scale?: number; hollow?: boolean } = {},
  ) {
    this.scale = opts.scale ?? 1;
    this.pixel = size <= 20;
    this.grid = size <= 16 ? 7 : 9;
    this.hollow = !!opts.hollow && this.pixel && this.grid === 9;
    for (let j = 0; j < PARTICLES; j++) this.pos[j * STRIDE + 3] = 0.2;
  }

  /** Particles sit on the border of the grid, the centre stays free (the tab number sits there). */
  private readonly hollow: boolean;

  get minFrameMs(): number {
    return this.size < SMALL_PX ? SMALL_FRAME_MS : 0;
  }

  private target(activity: LoaderActivity, t: number, cache?: Map<string, Particle[]>): Particle[] {
    const shape = SHAPES[activity];
    let raw: Particle[];
    if (activity === 'done' && !this.pixel) {
      raw = shape.fn(t, this.grid, this.pixel, Math.max(0, t - this.since));
    } else {
      const key = `${activity}|${this.grid}|${this.pixel}`;
      raw = cache?.get(key) ?? shape.fn(t, this.grid, this.pixel, 0);
      cache?.set(key, raw);
    }
    raw = raw.length > PARTICLES ? raw.slice(0, PARTICLES) : raw;
    if (!this.hollow) return raw;
    // Push every point out onto the border of the square, so none lands in the centre.
    return raw.map((p) => {
      const m = Math.max(Math.abs(p[0]), Math.abs(p[1]));
      if (m < 1e-3) return [0, 0, 0, p[3]] as Particle;
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
        const d = (this.pos[b] - g[0]) ** 2 + (this.pos[b + 1] - g[1]) ** 2 + (this.pos[b + 2] < 0.05 ? 0.5 : 0);
        if (d < bd) { bd = d; best = j; }
      });
      free.delete(best);
      this.mapping[best] = i;
    });
    this.mapLen = raw.length;
  }

  step(activity: LoaderActivity, t: number, dt: number, cache?: Map<string, Particle[]>): void {
    if (this.activity !== activity) { this.activity = activity; this.since = t; this.mapLen = -1; }
    const raw = this.target(activity, t, cache);
    if (this.mapLen !== raw.length) this.assign(raw);
    const rate = 1 - Math.exp(-dt * (this.pixel ? 16 : 6.5));
    for (let j = 0; j < PARTICLES; j++) {
      const b = j * STRIDE;
      const i = this.mapping[j];
      const g = i >= 0 ? raw[i] : null;
      for (let k = 0; k < STRIDE; k++) {
        const goal = g ? g[k] : k === 2 ? 0 : this.pos[b + k];
        this.pos[b + k] += (goal - this.pos[b + k]) * rate;
      }
    }
  }

  /** Jump straight to the shape of `activity` (the reduced-motion still frame). */
  snap(activity: LoaderActivity, t: number): void {
    this.step(activity, t, 0);
    this.step(activity, t, 10);
  }

  draw(color: string): void {
    const c = this.ctx;
    const W = this.size * this.scale;
    c.clearRect(0, 0, W, W);
    c.fillStyle = color;
    const pos = this.pos;
    if (this.pixel) {
      const n = this.grid;
      const p = Math.floor(W / n);
      const m = Math.floor((W - n * p) / 2);
      let gap = Math.max(1, Math.round(p * 0.14));
      if (p - gap < 1) gap = 0;
      const q = p - gap;
      const rr = Math.max(0.6, q * 0.3);
      const a = new Float32Array(n * n);
      // Small: every point falls on its own cell, edges are crisp and sit on device pixels.
      for (let j = 0; j < PARTICLES; j++) {
        const b = j * STRIDE;
        const x = Math.round(((pos[b] / 0.92 + 1) / 2) * (n - 1));
        const y = Math.round(((pos[b + 1] / 0.92 + 1) / 2) * (n - 1));
        if (x >= 0 && y >= 0 && x < n && y < n) a[y * n + x] = Math.max(a[y * n + x], pos[b + 2]);
      }
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const v = a[y * n + x];
          if (v < 0.06) continue;
          c.globalAlpha = Math.sqrt(v);
          c.beginPath();
          c.roundRect(m + x * p + gap / 2, m + y * p + gap / 2, q, q, rr);
          c.fill();
        }
      }
    } else {
      const R = W * 0.4;
      const base = (W / 9) * 0.58;
      for (let j = 0; j < PARTICLES; j++) {
        const b = j * STRIDE;
        if (pos[b + 2] < 0.02) continue;
        const q = base * pos[b + 3];
        c.globalAlpha = Math.min(1, pos[b + 2]);
        c.beginPath();
        c.roundRect(W / 2 + pos[b] * R - q / 2, W / 2 + pos[b + 1] * R - q / 2, q, q, q * 0.28);
        c.fill();
      }
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
      // Non `document.hidden`: con l'app dietro a un'altra e' falso, e si disegnerebbe per nessuno.
      hidden: () => !isWindowAwake(),
    });
    onWindowAwakeChange(() => shared?.visibilityChanged());
  }
  return shared;
}
