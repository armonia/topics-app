#!/usr/bin/env bun
/**
 * THE TRAY'S LOADER FRAMES, TAKEN FROM THE REAL ENGINE.
 *
 * The menu-bar strip draws the working glyph as the square loader of the app,
 * in the shape of what the agents are doing. It cannot run the engine itself
 * (it is Rust, and on macOS each frame is a pre-built image swapped on a
 * CALayer), and a hand-made copy of the shapes would drift from the approved
 * ones the first time somebody tunes a movement. So this script runs
 * `LoaderBody` of `client/src/components/Layout/squareLoader.ts` at the size of
 * the tray glyph, records every rounded square it draws through a fake canvas,
 * and writes the squares of each frame into
 * `desktop-tauri/src-tauri/src/tray_loader_frames.rs`. The Rust side only
 * rasterizes them.
 *
 * WHAT IS SAMPLED. For each shape the tray can show (the shapes the action map
 * of `loaderState.ts` reaches), the body is first run for several seconds at the
 * 30 fps a small body steps at in the app, so it has settled into its loop; then
 * one natural cycle of the shape is cut into as many frames as fit at the
 * tray's frame time (`FRAME_MS` in `tray_agents.rs`), at most `MAX_FRAMES`. When
 * the cycle is longer than that, the tray plays it a little faster: same frames,
 * same order, never a seam, because the samples are evenly spaced phases of one
 * cycle.
 *
 * The sizes come from the Rust sources (`OVERLAY_PT` in tray_agents.rs,
 * `SCALE` in tray_quota.rs), so a resized glyph regenerates without edits here.
 *
 *   bun scripts/gen-tray-loader-frames.ts           write the Rust file
 *   bun scripts/gen-tray-loader-frames.ts --check   exit 1 if it differs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LoaderBody, SETTLE_S, type LoaderActivity, type LoaderContext } from '../client/src/components/Layout/squareLoader';
import { loaderActivityForAction } from '../client/src/components/Layout/loaderState';
import { AGENT_ACTIONS } from '../shared/agent-action';

const ROOT = join(import.meta.dir, '..');
const TAURI_SRC = join(ROOT, 'desktop-tauri', 'src-tauri', 'src');
export const OUT_PATH = join(TAURI_SRC, 'tray_loader_frames.rs');

/** A loop longer than this many frames is played faster rather than cut. */
const MAX_FRAMES = 24;
/** The app steps a small settled body at 30 fps (`SMALL_FRAME_MS` in squareLoader). */
const SIM_DT = 1 / 30;
/** Long past the engine's one-second settle, so the loop sampled is the steady one. */
const SETTLE_SECONDS = 12;
/** A change starts on every this-many-th loop frame: at 120 ms a frame, it waits 0.6 s at most. */
const TRANSITION_STRIDE = 5;
/** A change that has not landed on the new loop by then is a bug of the engine or of this script. */
const MAX_TRANSITION_S = 2.5;

/**
 * One natural cycle of each tiny shape, in seconds, read off `SMALL_SHAPES`:
 * the shortest time after which the drawn image repeats. `think` is a quarter
 * turn (four alike squares), `error` the three-second period of its shake.
 * The generator checks that each one really closes, so an engine change that
 * breaks a period fails here instead of shipping a stutter.
 */
const CYCLE_S: Partial<Record<LoaderActivity, number>> = {
  think: (2 * Math.PI) / 1.5 / 4,
  search: (2 * Math.PI) / 2.2,
  write: 11 / 3.2,
  tool: (2 * Math.PI) / 3.6,
  wait: (2 * Math.PI) / 2.2,
  error: 3,
};

/** A rounded square as the engine drew it: x, y, side, alpha, in device pixels of the glyph box. */
export type Square = [number, number, number, number];

/** The change from one shape to another, starting from frame `fromFrame` of `from`'s loop. */
export interface TrayLoaderTransition {
  from: LoaderActivity;
  fromFrame: number;
  to: LoaderActivity;
  /** The images after the change, one every `transitionMs`. */
  frames: Square[][];
  /** The frame of `to`'s loop the body reaches next: the tray goes on from there. */
  land: number;
}

export interface TrayLoaderShape {
  activity: LoaderActivity;
  cycleS: number;
  frames: Square[][];
  /** The still frame the app draws under `prefers-reduced-motion` (`snap` at t = 2). */
  still: Square[];
}

/** Reads `const NAME: f32 = 11.0;` (or `= OTHER;`) from a Rust source, following one alias. */
function readRustNumber(src: string, name: string): number {
  const m = src.match(new RegExp(`const ${name}: (?:f32|u64|u32) = ([A-Za-z0-9_.]+);`));
  if (!m) throw new Error(`const ${name} not found`);
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : readRustNumber(src, m[1]);
}

export function trayGeometry(): { glyphPt: number; scale: number; frameMs: number; transitionMs: number } {
  const agents = readFileSync(join(TAURI_SRC, 'tray_agents.rs'), 'utf8');
  const quota = readFileSync(join(TAURI_SRC, 'tray_quota.rs'), 'utf8');
  return {
    glyphPt: readRustNumber(agents, 'OVERLAY_PT'),
    scale: readRustNumber(quota, 'SCALE'),
    frameMs: readRustNumber(agents, 'FRAME_MS'),
    transitionMs: readRustNumber(agents, 'TRANSITION_FRAME_MS'),
  };
}

/** The shapes the tray can reach: the image of the action map, in the map's order. */
export function trayActivities(): LoaderActivity[] {
  return [...new Set(AGENT_ACTIONS.map((a) => loaderActivityForAction(a)!))];
}

/** A canvas that only records the squares the body fills. */
class RecordingContext implements LoaderContext {
  fillStyle: string | CanvasGradient | CanvasPattern = '';
  globalAlpha = 1;
  squares: Square[] = [];
  private pending: [number, number, number] | null = null;
  clearRect(): void { this.squares = []; }
  beginPath(): void { this.pending = null; }
  roundRect(x: number, y: number, w: number, h: number, r: number): void {
    // The engine draws squares with a corner of 0.28 of the side; the Rust side assumes it.
    if (w !== h || Math.abs(r - w * 0.28) > 1e-6) throw new Error(`unexpected rect ${w}x${h} r${r}`);
    this.pending = [x, y, w];
  }
  fill(): void {
    if (this.pending) this.squares.push([...this.pending, this.globalAlpha]);
  }
}

const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

/** Two frames draw the same image: the same squares, in any order (a quarter turn of `think` swaps them), alpha within a hair. */
function sameImage(a: Square[], b: Square[]): boolean {
  if (a.length !== b.length) return false;
  const key = (q: Square) => `${q[0]},${q[1]},${q[2]}`;
  const sa = [...a].sort((p, q) => key(p).localeCompare(key(q)));
  const sb = [...b].sort((p, q) => key(p).localeCompare(key(q)));
  return sa.every((q, i) => q[0] === sb[i][0] && q[1] === sb[i][1] && q[2] === sb[i][2] && Math.abs(q[3] - sb[i][3]) < 0.01);
}

/** A body warmed into the steady loop of `activity`, stepping on the loop's sampling grid. */
function loopRun(activity: LoaderActivity, glyphPt: number, scale: number, frameMs: number) {
  const cycleS = CYCLE_S[activity];
  if (!cycleS) throw new Error(`no cycle declared for '${activity}'`);
  const ctx = new RecordingContext();
  const body = new LoaderBody(glyphPt, ctx, { scale });
  const run = { t: 0, body, cycleS, count: 0, phase: 0, start: 0 };
  /** Steps `shape` up to time `to`, never more than `maxDt` a step (the app's pace for that phase). */
  const advance = (to: number, shape: LoaderActivity = activity, maxDt = SIM_DT) => {
    const n = Math.max(1, Math.ceil((to - run.t) / maxDt - 1e-9));
    const dt = (to - run.t) / n;
    for (let i = 0; i < n; i++) { run.t += dt; body.step(shape, run.t, dt); }
  };
  const grab = (): Square[] => {
    body.draw('#000');
    return ctx.squares.map(([x, y, s, a]) => [round(x), round(y), round(s), round(a)] as Square);
  };
  body.step(activity, 0, 0);
  run.count = Math.min(MAX_FRAMES, Math.max(1, Math.round(cycleS / (frameMs / 1000))));
  run.phase = cycleS / run.count;
  // Warm up on the sampling grid itself, so the steady loop is reached with the very steps it is sampled at.
  run.start = Math.ceil(SETTLE_SECONDS / run.phase) * run.phase;
  for (let k = 1; k * run.phase <= run.start + 1e-9; k++) advance(k * run.phase);
  /** Moves the loop on to its frame `k` (counted from the start of the sampled cycle). */
  const toFrame = (k: number) => advance(run.start + k * run.phase);
  return { run, advance, grab, toFrame };
}

function sample(activity: LoaderActivity, glyphPt: number, scale: number, frameMs: number): TrayLoaderShape {
  const { run, grab, toFrame } = loopRun(activity, glyphPt, scale, frameMs);
  const frames: Square[][] = [grab()];
  for (let k = 1; k <= run.count; k++) {
    toFrame(k);
    frames.push(grab());
  }
  // The frame one cycle on must be the first one again, or the loop would jump.
  const close = frames.pop()!;
  if (!sameImage(close, frames[0])) {
    throw new Error(`'${activity}' does not close after ${round(run.cycleS)} s: its cycle in CYCLE_S is wrong`);
  }
  // A shape that does not move at this size (the shake of `error` is under a pixel) is one frame, not a loop of copies.
  const loop = frames.every((f) => sameImage(f, frames[0])) ? [frames[0]] : frames;
  const stillCtx = new RecordingContext();
  const stillBody = new LoaderBody(glyphPt, stillCtx, { scale });
  stillBody.snap(activity, 2);
  stillBody.draw('#000');
  const still = stillCtx.squares.map(([x, y, s, a]) => [round(x), round(y), round(s), round(a)] as Square);
  return { activity, cycleS: run.cycleS, frames: loop, still };
}

/**
 * THE CHANGE FROM ONE SHAPE TO ANOTHER, as the app plays it: the body of `from`,
 * caught in its steady loop at frame `fromFrame`, is handed `to` and stepped as
 * the app steps a body that changes shape (every frame, 60 a second, until it has
 * settled; then the 30 fps of a settled small body). One image every
 * `transitionMs`, until the change has settled AND the image is one of the
 * frames of `to`'s loop: the tray goes on from that frame, so the hand-over
 * has no seam. Its first image is the one after the change: the frame before it
 * is `fromFrame` of the loop.
 */
function sampleTransition(
  from: TrayLoaderShape, fromFrame: number, to: TrayLoaderShape,
  geo: { glyphPt: number; scale: number; frameMs: number; transitionMs: number },
): TrayLoaderTransition {
  const { run, advance, grab, toFrame } = loopRun(from.activity, geo.glyphPt, geo.scale, geo.frameMs);
  toFrame(fromFrame);
  const t0 = run.t;
  const step = geo.transitionMs / 1000;
  const frames: Square[][] = [];
  for (let j = 1; ; j++) {
    const at = t0 + j * step;
    // During the change the app gives the body every frame; once settled, 30 a second.
    advance(at, to.activity, at - t0 <= SETTLE_S + 1e-9 ? 1 / 60 : SIM_DT);
    const image = grab();
    if (at - t0 >= SETTLE_S - 1e-9) {
      const land = to.frames.findIndex((f) => sameImage(f, image));
      if (land >= 0) return { from: from.activity, fromFrame, to: to.activity, frames, land };
    }
    frames.push(image);
    if (at - t0 > MAX_TRANSITION_S) {
      throw new Error(`'${from.activity}' -> '${to.activity}' from frame ${fromFrame} never lands on a frame of the loop`);
    }
  }
}

/** The loop frames a change can start from: every TRANSITION_STRIDE-th, so a change waits a few frames at most. */
export function transitionAnchors(count: number): number[] {
  return Array.from({ length: Math.ceil(count / TRANSITION_STRIDE) }, (_, i) => i * TRANSITION_STRIDE);
}

export function sampleTrayLoader(): { geometry: ReturnType<typeof trayGeometry>; shapes: TrayLoaderShape[]; transitions: TrayLoaderTransition[] } {
  const geometry = trayGeometry();
  const shapes = trayActivities().map((a) => sample(a, geometry.glyphPt, geometry.scale, geometry.frameMs));
  const transitions: TrayLoaderTransition[] = [];
  for (const from of shapes) {
    for (const fromFrame of transitionAnchors(from.frames.length)) {
      for (const to of shapes) if (to !== from) transitions.push(sampleTransition(from, fromFrame, to, geometry));
    }
  }
  return { geometry, shapes, transitions };
}

const num = (v: number) => (Number.isInteger(v) ? `${v}.0` : `${v}`);

export function renderTrayLoaderFrames(): string {
  const { geometry, shapes, transitions } = sampleTrayLoader();
  const box = Math.round(geometry.glyphPt * geometry.scale);
  const lines: string[] = [
    '// @generated by scripts/gen-tray-loader-frames.ts from the square loader engine',
    '// (client/src/components/Layout/squareLoader.ts). Do not edit: change the engine or',
    '// the action map in loaderState.ts and run `bun scripts/gen-tray-loader-frames.ts`.',
    '//',
    `// Each square is [x, y, side, alpha] in device pixels of a ${box}x${box} box, corner radius`,
    '// 0.28 of the side, filled source-over in the glyph colour at that alpha.',
    '',
    `/// Side of the square box the frames are drawn in, device pixels (${geometry.glyphPt} pt at ${geometry.scale}x).`,
    `pub const BOX_PX: u32 = ${box};`,
    '/// Corner radius of each square, as a fraction of its side.',
    'pub const CORNER: f32 = 0.28;',
    '',
    '/// One loader shape: its name in the engine and one cycle of frames.',
    'pub struct LoaderShape {',
    '    pub activity: &\'static str,',
    '    pub frames: &\'static [&\'static [[f32; 4]]],',
    '    /// The still frame the app shows under reduced motion; a glyph that must not move draws it.',
    '    pub still: &\'static [[f32; 4]],',
    '}',
    '',
    '/// The shapes the tray can play, sampled at the tray frame time.',
    'pub const SHAPES: &[LoaderShape] = &[',
  ];
  for (const s of shapes) {
    lines.push(`    // ${s.activity}: ${s.frames.length} frame(s) for a ${round(s.cycleS, 2)} s cycle`);
    lines.push('    LoaderShape {');
    lines.push(`        activity: "${s.activity}",`);
    lines.push('        frames: &[');
    for (const f of s.frames) {
      lines.push(`            &[${f.map((q) => `[${q.map(num).join(', ')}]`).join(', ')}],`);
    }
    lines.push('        ],');
    lines.push(`        still: &[${s.still.map((q) => `[${q.map(num).join(', ')}]`).join(', ')}],`);
    lines.push('    },');
  }
  lines.push('];', '');
  const square = (q: Square) => `[${q.map(num).join(', ')}]`;
  const index = (a: LoaderActivity) => shapes.findIndex((s) => s.activity === a);
  lines.push(
    '/// A change of shape as the app plays it: from frame `from_frame` of the loop of',
    '/// `SHAPES[from]`, one image every `TRANSITION_FRAME_MS`, then frame `land` of the loop',
    '/// of `SHAPES[to]` and on. A change only starts on the frames listed here.',
    'pub struct LoaderTransition {',
    '    pub from: usize,',
    '    pub from_frame: usize,',
    '    pub to: usize,',
    "    pub frames: &'static [&'static [[f32; 4]]],",
    '    pub land: usize,',
    '}',
    '',
    `/// Every change between two shapes, from every ${TRANSITION_STRIDE}th frame of a loop.`,
    'pub const TRANSITIONS: &[LoaderTransition] = &[',
  );
  for (const tr of transitions) {
    lines.push(`    // ${tr.from} frame ${tr.fromFrame} -> ${tr.to}: ${tr.frames.length} image(s), lands on frame ${tr.land}`);
    lines.push(`    LoaderTransition { from: ${index(tr.from)}, from_frame: ${tr.fromFrame}, to: ${index(tr.to)}, land: ${tr.land}, frames: &[`);
    for (const f of tr.frames) lines.push(`        &[${f.map(square).join(', ')}],`);
    lines.push('    ] },');
  }
  lines.push('];', '');
  lines.push('/// Which shape each agent action plays: the action map of loaderState.ts, by wire word.');
  lines.push('pub const SHAPE_FOR_ACTION: &[(&str, &str)] = &[');
  for (const a of AGENT_ACTIONS) lines.push(`    ("${a}", "${loaderActivityForAction(a)}"),`);
  lines.push('];', '');
  return lines.join('\n');
}

if (import.meta.main) {
  const next = renderTrayLoaderFrames();
  if (process.argv.includes('--check')) {
    let current = '';
    try { current = readFileSync(OUT_PATH, 'utf8'); } catch { /* missing counts as different */ }
    if (current !== next) {
      console.error('tray_loader_frames.rs differs from the engine: run bun scripts/gen-tray-loader-frames.ts');
      process.exit(1);
    }
    console.log('tray_loader_frames.rs matches the engine');
  } else {
    writeFileSync(OUT_PATH, next);
    console.log(`wrote ${OUT_PATH}`);
  }
}
