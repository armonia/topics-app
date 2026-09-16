/**
 * THE FROST, built the way frost is built.
 *
 * Window frost nucleates at the COLD EDGES of a pane and grows inward as
 * feathery dendrites with 60-degree side branches over a fine hoarfrost grain,
 * behind a ragged front. This module is that description and nothing else: a
 * blur with a blue tint reads as a smudge, and the owner asked for a freeze that
 * looks real.
 *
 * WHY IT IS PURE, AND WHY IT IS A BITMAP. The fields are computed once per size
 * and seed into typed arrays; a frame is then one pass of `ImageData` writing.
 * No SVG filter (re-rasterised on the CPU at every repaint), no `backdrop-filter`
 * (it reads the layer behind it on every frame), no WebGL (one context per page,
 * and there is a cap). At rest the canvas is a STILL bitmap with no loop at all:
 * the frost appears exactly while the machine is thrashing, so a texture that
 * kept painting would be taking the very cycles the freeze just bought.
 *
 * THE KEEP-OUT IS NOT A DETAIL. Crystals do not form over the printed words:
 * computed on the real tokens, the dark theme allows a crystal alpha of at most
 * 0.366 under `--text`, 0.189 under `--text-secondary` and 0.066 under
 * `--text-muted` before contrast falls under 4.5:1 - a texture that faint is
 * invisible. So the texture stays strong and grows AROUND the text boxes, which
 * is also what frost on a pane does around anything warm.
 */

export interface Rect { x: number; y: number; w: number; h: number }

export interface IceTheme {
  /** The dendrites and the hoarfrost grain. */
  crystal: readonly [number, number, number];
  /** The thin veil between them. */
  wash: readonly [number, number, number];
  /** The rim of the front, and the droplets of the melt. */
  edge: readonly [number, number, number];
}

export interface IceFields {
  /** Device pixels. */
  width: number;
  height: number;
  scale: number;
  /**
   * The front: a pixel is frosted once `progress` reaches its value. `Infinity`
   * beyond the reach, so the middle of a card never frosts however long it waits.
   */
  front: Float32Array;
  /** Dendrite coverage, 0-1. */
  crystal: Float32Array;
  /** Hoarfrost grain, 0-1. */
  grain: Float32Array;
}

/** Deterministic per tree: the same freeze frosts the same way on every surface. */
export function mulberry32(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Value noise on a lattice, smoothstep-interpolated: the grain of the pane. */
function valueNoise(rnd: () => number, period: number, width: number, height: number): (x: number, y: number) => number {
  const cols = Math.max(2, Math.ceil(width / period) + 2);
  const rows = Math.max(2, Math.ceil(height / period) + 2);
  const lattice = new Float32Array(cols * rows);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rnd();
  const smooth = (t: number): number => t * t * (3 - 2 * t);
  return (x, y) => {
    const fx = x / period;
    const fy = y / period;
    const x0 = Math.min(cols - 2, Math.max(0, Math.floor(fx)));
    const y0 = Math.min(rows - 2, Math.max(0, Math.floor(fy)));
    const tx = smooth(Math.min(1, Math.max(0, fx - x0)));
    const ty = smooth(Math.min(1, Math.max(0, fy - y0)));
    const a = lattice[y0 * cols + x0]!, b = lattice[y0 * cols + x0 + 1]!;
    const c = lattice[(y0 + 1) * cols + x0]!, d = lattice[(y0 + 1) * cols + x0 + 1]!;
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  };
}

/**
 * The fields of one frosted surface.
 *
 * `reach` is how far inward the frost can grow, in CSS pixels: a card gets
 * `clamp(0.42 * min(w, h), 40, 90)` with three levels of branching, a row or a
 * tab gets 8 px and one, which reads as rime along the edge instead of a pattern
 * nobody can see at 28 px tall.
 */
export function iceFields(o: { w: number; h: number; scale: number; seed: string; reach: number; depth: 1 | 3 }): IceFields {
  const scale = Math.max(1, Math.min(2, o.scale));
  const width = Math.max(1, Math.round(o.w * scale));
  const height = Math.max(1, Math.round(o.h * scale));
  const reach = Math.max(2, o.reach * scale);
  const random = mulberry32(o.seed);
  const fbm = (() => {
    const octaves = [
      { n: valueNoise(random, 48 * scale, width, height), amp: 0.5 },
      { n: valueNoise(random, 24 * scale, width, height), amp: 0.25 },
      { n: valueNoise(random, 12 * scale, width, height), amp: 0.15 },
      { n: valueNoise(random, 6 * scale, width, height), amp: 0.1 },
    ];
    return (x: number, y: number) => octaves.reduce((sum, o2) => sum + o2.amp * o2.n(x, y), 0);
  })();
  const warp = valueNoise(random, 64 * scale, width, height);

  const front = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // The distance to the nearest edge, with the CORNERS pulled forward: a
      // cold frame chills them first, so the front starts there and closes along
      // the sides. The pull dies off within a reach of the corner, which is why
      // the middle of a wide card stays clear (a plain harmonic blend of the two
      // distances covers it: 48 px of "distance" at the centre of a 320x140).
      const dx = Math.min(x, width - 1 - x) + 0.5;
      const dy = Math.min(y, height - 1 - y) + 0.5;
      const d = Math.min(dx, dy) - reach * 0.35 * Math.exp(-(dx + dy) / reach);
      const i = y * width + x;
      if (d > reach) { front[i] = Infinity; continue; }
      const wx = x + (warp(x, y) - 0.5) * 12 * scale;
      const wy = y + (warp(y, x) - 0.5) * 12 * scale;
      front[i] = d / reach + 0.45 * (fbm(wx, wy) - 0.5);
    }
  }

  const crystal = new Float32Array(width * height);
  growDendrites(crystal, { width, height, reach, scale, rnd: random, depth: o.depth });

  const grain = new Float32Array(width * height);
  for (let i = 0; i < grain.length; i++) grain[i] = random();

  return { width, height, scale, front, crystal, grain };
}

/** A feather of ice: a stem inward, side branches at 60 degrees, recursively. */
function growDendrites(
  out: Float32Array,
  o: { width: number; height: number; reach: number; scale: number; rnd: () => number; depth: 1 | 3 },
): void {
  const { width, height, reach, scale, rnd } = o;
  const step = 3 * scale;
  const mark = (x: number, y: number, weight: number): void => {
    const px = Math.round(x);
    const py = Math.round(y);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const qx = px + dx;
        const qy = py + dy;
        if (qx < 0 || qy < 0 || qx >= width || qy >= height) continue;
        const falloff = dx === 0 && dy === 0 ? 1 : 0.45;
        const i = qy * width + qx;
        out[i] = Math.min(1, out[i]! + weight * falloff);
      }
    }
  };
  const branch = (x: number, y: number, angle: number, length: number, depth: number): void => {
    let cx = x;
    let cy = y;
    let travelled = 0;
    let sinceBranch = 0;
    let a = angle;
    while (travelled < length) {
      a += (rnd() - 0.5) * (25 * Math.PI / 180);
      cx += Math.cos(a) * step;
      cy += Math.sin(a) * step;
      travelled += step;
      sinceBranch += step;
      if (cx < -step || cy < -step || cx > width + step || cy > height + step) return;
      mark(cx, cy, depth === 0 ? 0.9 : 0.6);
      const every = (6 + rnd() * 4) * scale;
      if (depth < o.depth - 1 && sinceBranch >= every) {
        sinceBranch = 0;
        const side = 60 * Math.PI / 180;
        branch(cx, cy, a + side, length * 0.55, depth + 1);
        branch(cx, cy, a - side, length * 0.55, depth + 1);
      }
    }
  };

  const spacing = Math.max(8, 28 * scale);
  const seedsPerEdge = (span: number): number => Math.max(1, Math.round(span / spacing));
  const edges: Array<{ at: (t: number) => [number, number]; inward: number; span: number }> = [
    { at: (t) => [t * width, 0], inward: Math.PI / 2, span: width },
    { at: (t) => [t * width, height - 1], inward: -Math.PI / 2, span: width },
    { at: (t) => [0, t * height], inward: 0, span: height },
    { at: (t) => [width - 1, t * height], inward: Math.PI, span: height },
  ];
  for (const edge of edges) {
    const n = seedsPerEdge(edge.span);
    for (let k = 0; k < n; k++) {
      const [x, y] = edge.at((k + 0.5 + (rnd() - 0.5) * 0.6) / n);
      branch(x, y, edge.inward + (rnd() - 0.5) * 0.6, reach * (0.6 + rnd() * 0.5), 0);
    }
  }
}

/**
 * Where frost must not form: the text boxes of the host, inflated and feathered.
 * 0 inside, 1 past the feather.
 */
export function keepOutMask(o: {
  w: number; h: number; scale: number;
  rects: readonly Rect[];
  inflate?: number;
  feather?: number;
}): Float32Array {
  const scale = Math.max(1, Math.min(2, o.scale));
  const width = Math.max(1, Math.round(o.w * scale));
  const height = Math.max(1, Math.round(o.h * scale));
  const inflate = (o.inflate ?? 2) * scale;
  const feather = Math.max(1, (o.feather ?? 5) * scale);
  const mask = new Float32Array(width * height).fill(1);
  for (const r of o.rects) {
    const x0 = r.x * scale - inflate;
    const y0 = r.y * scale - inflate;
    const x1 = (r.x + r.w) * scale + inflate;
    const y1 = (r.y + r.h) * scale + inflate;
    const fromX = Math.max(0, Math.floor(x0 - feather));
    const toX = Math.min(width - 1, Math.ceil(x1 + feather));
    const fromY = Math.max(0, Math.floor(y0 - feather));
    const toY = Math.min(height - 1, Math.ceil(y1 + feather));
    for (let y = fromY; y <= toY; y++) {
      for (let x = fromX; x <= toX; x++) {
        // Distance OUTSIDE the inflated box; 0 while inside it.
        const dx = Math.max(x0 - x, 0, x - x1);
        const dy = Math.max(y0 - y, 0, y - y1);
        const d = Math.hypot(dx, dy);
        const v = Math.min(1, d / feather);
        const i = y * width + x;
        if (v < mask[i]!) mask[i] = v;
      }
    }
  }
  return mask;
}

/**
 * One frame. `progress` is how far the front has travelled (0 clear, 1 fully
 * grown); `melting` deepens the rim and is what the thaw runs backwards.
 */
export function paintIce(
  img: ImageData,
  f: IceFields,
  o: { progress: number; melting: boolean; theme: IceTheme; keepOut?: Float32Array },
): void {
  const data = img.data;
  const progress = Math.max(0, Math.min(1, o.progress));
  const [cr, cg, cb] = o.theme.crystal;
  const [wr, wg, wb] = o.theme.wash;
  const [er, eg, eb] = o.theme.edge;
  for (let i = 0; i < f.front.length; i++) {
    const t = f.front[i]!;
    const p = i * 4;
    if (!(t <= progress)) { data[p + 3] = 0; continue; }
    const keep = o.keepOut ? o.keepOut[i]! : 1;
    if (keep <= 0) { data[p + 3] = 0; continue; }
    const crystal = f.crystal[i]!;
    const grain = f.grain[i]! * 0.08;
    const rim = progress - t < 0.03;
    const alpha = Math.min(1, (0.16 + 0.7 * crystal + grain) * keep * (o.melting && rim ? 1.4 : 1));
    // The wash between the dendrites, the crystal on them, the rim colour where
    // the front is (and, while melting, the wet edge that reads as water).
    const mix = Math.min(1, crystal * 1.2);
    const rimMix = o.melting && rim ? 0.6 : 0;
    data[p] = Math.round((wr * (1 - mix) + cr * mix) * (1 - rimMix) + er * rimMix);
    data[p + 1] = Math.round((wg * (1 - mix) + cg * mix) * (1 - rimMix) + eg * rimMix);
    data[p + 2] = Math.round((wb * (1 - mix) + cb * mix) * (1 - rimMix) + eb * rimMix);
    data[p + 3] = Math.round(alpha * 255);
  }
}

/** The tips a glint can sit on: dendrite ends that are not over any text. */
export function glintPoints(f: IceFields, keepOut: Float32Array | undefined, max = 5): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  const stride = Math.max(1, Math.floor(f.front.length / 4000));
  for (let i = 0; i < f.front.length && out.length < max; i += stride) {
    if (f.crystal[i]! < 0.75) continue;
    if (keepOut && keepOut[i]! < 1) continue;
    if (!Number.isFinite(f.front[i]!)) continue;
    out.push({ x: (i % f.width) / f.scale, y: Math.floor(i / f.width) / f.scale });
  }
  return out;
}
