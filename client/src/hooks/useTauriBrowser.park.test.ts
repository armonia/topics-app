/**
 * THE PARK IS A LATCH: the bench that makes the five return paths no-ops.
 *
 * THE FAULT. Hiding a native pane was one fire-and-forget IPC. `setBounds`'s
 * zero branch pushed the view off-screen and nothing remembered it belonged
 * there, while `pendingRectRef` — the only input `applyBounds` has — kept the
 * rect the cell occupied BEFORE it collapsed, because the zero branch never
 * writes it. So every later `applyBounds()` put the page straight back on
 * screen. Five callers reach it without passing through the placeholder, so
 * none of them can know the pane has lost its box: `thaw()`, `setDevice`, the
 * user-agent reconcile, the responsive resize, and `recreate`'s handshake.
 *
 * WHAT THIS FILE ASSERTS, and why it is a count and not a look. "The view is
 * off screen" is not observable from a unit bench — there is no shell here and
 * no pixels. What IS observable is the only thing the shell ever receives: the
 * geometry commands. So the bench drives the REAL hook against a recording
 * `tauriInvoke` and counts `browser_set_bounds` / `browser_animate_bounds`. A
 * path that sends none cannot have moved anything.
 *
 * A SIXTH PATH, found while writing this. `recreate` does not reach the latch
 * only through its handshake: `applyOpened` re-pushes the stale
 * `pendingRectRef` through `setBounds` as soon as the new view answers, which
 * lands BEFORE the handshake. Guarding the handshake alone would have left the
 * return wide open, and the `recreate` case below is red without that guard.
 *
 * FALSIFICATION (it has been seen red): delete `hiddenRef` from
 * `useTauriBrowser.ts` — the guard at the top of `applyBounds`, the slot read in
 * `evaluateOcclusion`, or the flush guard in `applyOpened` — and the matching
 * case fails. Each of the three is load bearing on its own.
 *
 * @covers NATIVEPARK-01
 */
import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll, mock } from 'bun:test';
import { createElement } from 'react';
import { mount, type Harness } from '../test/reactHarness';
import * as tauriShell from '../lib/shell/tauri';
import * as occlusionModule from '../lib/shell/browserOcclusion';
import type { OverlayRect } from '../lib/shell/browserOcclusion';
import * as devTypes from '../components/Browser/browserDevTypes';
import * as paneContextModel from '../components/Browser/paneContextModel';
import * as browserNavUrl from '../lib/browserNavUrl';
import { DEVICE_PRESETS } from '../components/Browser/browserDevTypes';
import type { NativeBrowserHandle } from '../components/Browser/browserDevTypes';

// `bun test` does not resolve the `@/` alias of the client tsconfig, and the
// hook reaches three of its own modules through it. Registering them under the
// exact specifiers is what lets the REAL hook be driven here instead of the
// bench degrading into an assertion on its source text — same reason, and the
// same shape, as `useRemoteBrowser.leak.test.ts`. It has to happen before the
// hook is loaded, so the import below is dynamic.
mock.module('@/components/Browser/browserDevTypes', () => devTypes);
mock.module('@/components/Browser/paneContextModel', () => paneContextModel);
mock.module('@/lib/browserNavUrl', () => browserNavUrl);

const { useTauriBrowser } = await import('./useTauriBrowser');

/** The slot the pane occupies while its cell has a box. */
const SHOWN = { x: 120, y: 64, width: 400, height: 300 };
/** The zero rect the placeholder pushes when the pane has no box at all. */
const NO_BOX = { x: 0, y: 0, width: 0, height: 0 };
/** An overlay far away from {@link SHOWN}: it cannot intersect the stale rect. */
const FAR_OVERLAY: OverlayRect = { left: 900, top: 700, right: 1020, bottom: 780 };

interface Invocation { cmd: string; args: Record<string, unknown> }

let invocations: Invocation[] = [];
/** Commands whose answer the test wants to hold open until it says so. */
let deferredUserAgent: ((ua: string) => void) | null = null;
/** Commands the shell should refuse, by name. */
let refuse = new Set<string>();

const realTauri = {
  tauriInvoke: tauriShell.tauriInvoke,
  currentWindowLabel: tauriShell.currentWindowLabel,
  releaseNativeFocus: tauriShell.releaseNativeFocus,
};
const realOcclusion = { ...occlusionModule };

/** The overlay feed, driven by the test instead of by a MutationObserver. */
let overlays: readonly OverlayRect[] = [];
let occlusionListeners = new Set<(rects: OverlayRect[]) => void>();

function emitOverlays(rects: readonly OverlayRect[]): void {
  overlays = rects;
  for (const fn of [...occlusionListeners]) fn([...rects]);
}

beforeAll(() => {
  mock.module('../lib/shell/tauri', () => ({
    ...realTauri,
    currentWindowLabel: () => 'main',
    releaseNativeFocus: () => {},
    tauriInvoke: (cmd: string, args: Record<string, unknown> = {}) => {
      invocations.push({ cmd, args });
      if (refuse.has(cmd)) return Promise.reject(new Error(`shell refused ${cmd}`));
      if (cmd === 'browser_eval_js' && args.js === 'navigator.userAgent') {
        return new Promise((resolve) => { deferredUserAgent = resolve as (ua: string) => void; });
      }
      // An empty screenshot makes `freeze()` bail before it decodes an <Image>,
      // which no bench without a DOM could satisfy. The freeze still happens —
      // it is the invocation itself that witnesses the decision.
      if (cmd === 'browser_screenshot') return Promise.resolve('');
      return Promise.resolve('');
    },
  }));
  // The real decision (`decideFreeze`, `liveSlotRect`) is kept: what is replaced
  // is only the source of overlay events, which in production is a body-wide
  // MutationObserver and here is the test.
  mock.module('../lib/shell/browserOcclusion', () => ({
    ...realOcclusion,
    currentOverlays: () => overlays,
    onOcclusionChange: (fn: (rects: OverlayRect[]) => void) => {
      occlusionListeners.add(fn);
      fn([...overlays]);
      return () => { occlusionListeners.delete(fn); };
    },
  }));
});

afterAll(() => {
  mock.module('../lib/shell/tauri', () => realTauri);
  mock.module('../lib/shell/browserOcclusion', () => realOcclusion);
});

const g = globalThis as unknown as Record<string, unknown>;
const savedGlobals: Record<string, unknown> = {};
const DOM_KEYS = ['window', 'document', 'WebSocket', 'requestAnimationFrame'] as const;

class SilentSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = SilentSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  send(): void {}
  close(): void { this.readyState = SilentSocket.CLOSED; }
}

function eventTarget(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...extra,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (h: number) => clearTimeout(h),
    setInterval: () => 0,
    clearInterval: () => {},
  };
}

beforeEach(() => {
  invocations = [];
  refuse = new Set();
  deferredUserAgent = null;
  overlays = [];
  occlusionListeners = new Set();
  for (const k of DOM_KEYS) savedGlobals[k] = g[k];
  g.window = eventTarget({ location: { protocol: 'http:', host: '127.0.0.1:3333', href: 'http://127.0.0.1:3333/' } });
  // `querySelector` answers null for everything: there is no slot element and no
  // `.floating-splits`, which is exactly the shape `liveSlotRect` handles by
  // falling back to the cached rect — the fallback this change closes.
  g.document = eventTarget({ hidden: false, visibilityState: 'visible', querySelector: () => null });
  g.WebSocket = SilentSocket;
  g.requestAnimationFrame = (fn: (t: number) => void) => { fn(0); return 1; };
});

afterEach(() => {
  for (const k of DOM_KEYS) {
    if (savedGlobals[k] === undefined) delete g[k]; else g[k] = savedGlobals[k];
  }
});

/** Let every queued microtask (the IPC promises) settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

function geometryCommands(): Invocation[] {
  return invocations.filter((i) => i.cmd === 'browser_set_bounds' || i.cmd === 'browser_animate_bounds');
}

interface Bench { handle: () => NativeBrowserHandle; harness: Harness }

/** Mount the real hook, wait for the native view to answer, and show it once. */
async function openAndShow(): Promise<Bench> {
  const seen: NativeBrowserHandle[] = [];
  function Probe(): null {
    seen.push(useTauriBrowser('ctx-park', 'https://example.com/', true));
    return null;
  }
  const harness = mount(createElement(Probe));
  await settle();
  const handle = () => seen[seen.length - 1]!;
  handle().setBounds(SHOWN);
  await settle();
  return { handle, harness };
}

/** Show the pane, then collapse its cell. Returns the bench with the log cleared. */
async function openAndPark(): Promise<Bench> {
  const bench = await openAndShow();
  bench.handle().setBounds(NO_BOX);
  await settle();
  invocations = [];
  return bench;
}

describe('useTauriBrowser: il parcheggio e un chiavistello', () => {
  test('a zero rect parks the view at the last real size', async () => {
    const bench = await openAndShow();
    const beforePark = geometryCommands();
    expect(beforePark[beforePark.length - 1]?.args).toMatchObject({ x: SHOWN.x, y: SHOWN.y, width: SHOWN.width, height: SHOWN.height });

    invocations = [];
    bench.handle().setBounds(NO_BOX);
    await settle();

    const parked = geometryCommands();
    expect(parked).toHaveLength(1);
    expect(parked[0].args).toMatchObject({ x: -100000, width: SHOWN.width, height: SHOWN.height });
    bench.harness.unmount();
  });

  test('thaw does not bring a parked view back', async () => {
    const bench = await openAndPark();
    // An overlay arrives: parked, the decision is taken without a rect, so it
    // freezes. Clearing the overlays is what fires the thaw.
    emitOverlays([FAR_OVERLAY]);
    await settle();
    invocations = [];
    emitOverlays([]);
    await settle();

    expect(geometryCommands()).toEqual([]);
    bench.harness.unmount();
  });

  test('the device switch does not bring a parked view back', async () => {
    const bench = await openAndPark();
    bench.handle().setDevice('mobile');
    await settle();

    expect(geometryCommands()).toEqual([]);
    bench.harness.unmount();
  });

  test('the user-agent reconcile does not bring a parked view back', async () => {
    const bench = await openAndPark();
    // The reconcile fired when the view became ready and has been waiting on the
    // eval ever since; answering it now lands it AFTER the park, which is the
    // ordering that made it a return path.
    expect(deferredUserAgent).not.toBeNull();
    deferredUserAgent?.(DEVICE_PRESETS.mobile.userAgent ?? '');
    await settle();

    expect(geometryCommands()).toEqual([]);
    bench.harness.unmount();
  });

  test('the responsive resize does not bring a parked view back', async () => {
    const bench = await openAndPark();
    bench.handle().setResponsiveSize(520, 380);
    await settle();

    expect(geometryCommands()).toEqual([]);
    bench.harness.unmount();
  });

  test('a recreation does not bring a parked view back, handshake included', async () => {
    const bench = await openAndPark();
    await bench.handle().recreate?.();
    await settle();

    // The view was rebuilt — the bench is not green because nothing happened.
    expect(invocations.map((i) => i.cmd)).toContain('browser_open');
    expect(geometryCommands()).toEqual([]);
    bench.harness.unmount();
  });

  test('the freeze decision is taken without a rect, not on the one the cell used to have', async () => {
    const bench = await openAndPark();
    // FAR_OVERLAY misses the rect the cell occupied before collapsing: on the
    // stale rect the answer would be "nothing covers you" → thaw. Parked, there
    // is no rect at all, and `decideFreeze(null, rects)` freezes.
    emitOverlays([FAR_OVERLAY]);
    await settle();

    expect(invocations.map((i) => i.cmd)).toContain('browser_screenshot');
    bench.harness.unmount();
  });

  test('the first positive rect reopens the latch, restores the view and drops the fault', async () => {
    const bench = await openAndPark();
    // A fault declared while the cell was collapsed: three structural refusals
    // in a row are what `browserPaneFault` calls a dead pane.
    refuse.add('browser_reload');
    for (let i = 0; i < 3; i++) { void bench.handle().reload(); await settle(); }
    bench.harness.rerender();
    expect(bench.handle().nativeFault).not.toBeNull();

    refuse.delete('browser_reload');
    invocations = [];
    bench.handle().setBounds(SHOWN);
    await settle();
    bench.harness.rerender();

    const back = geometryCommands();
    expect(back).toHaveLength(1);
    expect(back[0].args).toMatchObject({ x: SHOWN.x, y: SHOWN.y, width: SHOWN.width, height: SHOWN.height });
    // Same call, both effects: `recordPaneOk` inside `paneInvoke` is the only
    // proof the pane has that something actually changed.
    expect(bench.handle().nativeFault).toBeNull();
    bench.harness.unmount();
  });
});
