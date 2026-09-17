/**
 * A HEAVY PANE PAUSES BEHIND A STILL AND COMES BACK WITHOUT A RELOAD.
 *
 * What the shell receives is all a unit bench can observe, so the REAL hook runs
 * against a recording `tauriInvoke` and the assertions are on the command
 * sequence: a still before the hide, nothing sent to a paused page, the resume
 * that parks, shows and only then puts the view back in its slot, and never a
 * reload, a navigation, an open or a close on the way.
 *
 * The case the previous design lost is here on purpose: resume while an overlay
 * covers the pane. `thaw()` returns early on a pane that was never frozen, so a
 * resume that relied on it left the pane paused until something unrelated moved.
 *
 * @covers BROWSER-HEAVY-04, BROWSER-HEAVY-05
 */
import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll, mock, jest } from 'bun:test';
import { createElement } from 'react';
import { mount, type Harness } from '../test/reactHarness';
import * as tauriShell from '../lib/shell/tauri';
import * as occlusionModule from '../lib/shell/browserOcclusion';
import type { OverlayRect } from '../lib/shell/browserOcclusion';
import * as devTypes from '../components/Browser/browserDevTypes';
import * as paneContextModel from '../components/Browser/paneContextModel';
import * as browserNavUrl from '../lib/browserNavUrl';
import type { NativeBrowserHandle } from '../components/Browser/browserDevTypes';
import { forgetPane, noteWebviewSample } from '../lib/shell/heavyPanes';
import { noteWindowFocusEvent } from '../lib/shell/windowFocus';
import { PAUSE_DWELL_MS } from '../lib/shell/nativePaneLive';

// `bun test` does not resolve the client's `@/` alias; see useTauriBrowser.park.test.ts.
mock.module('@/components/Browser/browserDevTypes', () => devTypes);
mock.module('@/components/Browser/paneContextModel', () => paneContextModel);
mock.module('@/lib/browserNavUrl', () => browserNavUrl);

const { useTauriBrowser } = await import('./useTauriBrowser');

const CTX = 'ctx-heavy';
const SLOT = { x: 40, y: 50, width: 640, height: 480 };
const OVER_SLOT: OverlayRect = { left: 100, top: 100, right: 300, bottom: 200 };

let inspectorOpen = false;
let fullScreen = false;
let pageState = '';
let calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
let overlays: readonly OverlayRect[] = [];
let occlusionListeners = new Set<(rects: OverlayRect[]) => void>();
let sockets: Array<{ emit: (type: string, data?: string) => void }> = [];

const realTauri = {
  tauriInvoke: tauriShell.tauriInvoke,
  currentWindowLabel: tauriShell.currentWindowLabel,
  releaseNativeFocus: tauriShell.releaseNativeFocus,
};
const realOcclusion = {
  OVERLAY_SELECTOR: occlusionModule.OVERLAY_SELECTOR,
  overlayPaints: occlusionModule.overlayPaints,
  slotIntersectsRects: occlusionModule.slotIntersectsRects,
  decideFreeze: occlusionModule.decideFreeze,
  liveSlotRect: occlusionModule.liveSlotRect,
  currentOverlays: occlusionModule.currentOverlays,
  onOcclusionChange: occlusionModule.onOcclusionChange,
  stopObserver: occlusionModule.stopObserver,
};

beforeAll(() => {
  mock.module('../lib/shell/tauri', () => ({
    ...realTauri,
    currentWindowLabel: () => 'main',
    releaseNativeFocus: () => {},
    tauriInvoke: (cmd: string, args: Record<string, unknown> = {}) => {
      calls.push({ cmd, args });
      if (cmd === 'browser_screenshot') return Promise.resolve('iVBORw0KGgo=');
      if (cmd === 'browser_devtools_open') return Promise.resolve(inspectorOpen);
      if (cmd === 'browser_eval_js') {
        const js = String(args.js ?? '');
        return Promise.resolve(js.includes('fullscreenElement') ? (fullScreen ? '1' : '') : pageState);
      }
      if (cmd.startsWith('browser_take_') || cmd === 'browser_nav_entries') return Promise.resolve([]);
      return Promise.resolve('');
    },
  }));
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
const saved: Record<string, unknown> = {};
const GLOBALS = ['window', 'document', 'WebSocket', 'requestAnimationFrame'] as const;

/** A socket the test can speak through, as the server would. */
class ScriptedSocket {
  private listeners = new Map<string, Array<(e: { data?: string }) => void>>();
  constructor() {
    sockets.push({ emit: (type, data) => { for (const fn of this.listeners.get(type) ?? []) fn({ data }); } });
  }
  addEventListener(type: string, fn: (e: { data?: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  send(): void {}
  close(): void {}
}

beforeEach(() => {
  jest.useFakeTimers();
  inspectorOpen = false;
  fullScreen = false;
  pageState = '';
  calls = [];
  overlays = [];
  occlusionListeners = new Set();
  sockets = [];
  for (const k of GLOBALS) saved[k] = g[k];
  const target = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (h: number) => clearTimeout(h),
    setInterval: (fn: () => void, ms?: number) => setInterval(fn, ms),
    clearInterval: (h: number) => clearInterval(h),
  };
  g.window = { ...target, location: { protocol: 'http:', host: '127.0.0.1:3333', href: 'http://127.0.0.1:3333/' } };
  g.document = { ...target, hidden: false, visibilityState: 'visible', querySelector: () => null };
  g.WebSocket = ScriptedSocket;
  g.requestAnimationFrame = (fn: (t: number) => void) => { fn(0); return 1; };
  noteWindowFocusEvent(true);
});

afterEach(() => {
  jest.useRealTimers();
  for (const k of GLOBALS) {
    if (saved[k] === undefined) delete g[k]; else g[k] = saved[k];
  }
});

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

async function advance(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms);
  await settle();
}

const names = () => calls.map((c) => c.cmd);
const visibility = () => calls.filter((c) => c.cmd === 'browser_set_visible').map((c) => c.args.visible);

interface Bench { handle: () => NativeBrowserHandle; harness: Harness; props: { hasFocus: boolean; isVisible: boolean } }

/** Mount a pane on screen with the focus, and let the verdict call it heavy. */
async function heavyPane(): Promise<Bench> {
  const props = { hasFocus: true, isVisible: true };
  const seen: NativeBrowserHandle[] = [];
  function Probe(): null {
    seen.push(useTauriBrowser(CTX, 'https://example.com/', props.isVisible, undefined, props.hasFocus));
    return null;
  }
  const harness = mount(createElement(Probe));
  await settle();
  const handle = () => seen[seen.length - 1]!;
  handle().setBounds(SLOT);
  await settle();
  // Live since the mount, navigated at the mount: samples from 10 s on count.
  const t0 = Date.now();
  for (const dt of [10_000, 15_000, 20_000]) {
    noteWebviewSample([{ label: `browserpane-${CTX}`, pid: 4242, cpu_percent: 17 }], t0 + dt);
  }
  harness.rerender();
  expect(handle().heavy?.cpu).toBe(17);
  return { handle, harness, props };
}

/** From a heavy pane, take the focus away and wait the dwell out. */
async function paused(bench: Bench, how: 'pane' | 'window' = 'pane'): Promise<void> {
  if (how === 'pane') { bench.props.hasFocus = false; bench.harness.rerender(); }
  else noteWindowFocusEvent(false);
  await advance(PAUSE_DWELL_MS);
  await advance(400);
  bench.harness.rerender();
  expect(bench.handle().paused).toBe(true);
}

function resumeByFocus(bench: Bench): void {
  bench.props.hasFocus = true;
  bench.harness.rerender();
}

describe('useTauriBrowser: a heavy pane pauses and resumes', () => {
  test('the still is taken before the view is hidden, never after', async () => {
    const bench = await heavyPane();
    calls = [];
    await paused(bench, 'window');
    const shot = names().indexOf('browser_screenshot');
    const hide = calls.findIndex((c) => c.cmd === 'browser_set_visible' && c.args.visible === false);
    expect(shot).toBeGreaterThanOrEqual(0);
    expect(hide).toBeGreaterThan(shot);
    bench.harness.unmount();
  });

  test('a glance inside the dwell pays nothing', async () => {
    const bench = await heavyPane();
    calls = [];
    noteWindowFocusEvent(false);
    bench.harness.rerender();
    await advance(PAUSE_DWELL_MS - 500);
    noteWindowFocusEvent(true);
    bench.harness.rerender();
    await advance(PAUSE_DWELL_MS * 2);
    expect(names()).not.toContain('browser_screenshot');
    expect(bench.handle().paused).toBe(false);
    bench.harness.unmount();
  });

  test('a paused page gets no eval and no geometry for 10 s', async () => {
    const bench = await heavyPane();
    await paused(bench, 'pane');
    calls = [];
    await advance(10_000);
    expect(names().filter((n) => n === 'browser_eval_js' || n === 'browser_set_bounds')).toEqual([]);
    // The native drains still run: this pane is on screen in a focused window.
    expect(names()).toContain('browser_take_nav_state');
    bench.harness.unmount();
  });

  test('resume parks, shows, then puts the view back in its slot, with no reload', async () => {
    const bench = await heavyPane();
    await paused(bench);
    calls = [];
    resumeByFocus(bench);
    await settle();
    const seq = calls
      .filter((c) => c.cmd === 'browser_set_bounds' || c.cmd === 'browser_set_visible')
      .map((c) => (c.cmd === 'browser_set_visible' ? `visible:${c.args.visible}` : `bounds:${c.args.x}`));
    expect(seq).toEqual(['bounds:-100000', 'visible:true', `bounds:${SLOT.x}`]);
    expect(names().filter((n) => ['browser_reload', 'browser_navigate', 'browser_open', 'browser_close'].includes(n))).toEqual([]);
    expect(bench.handle().paused).toBe(false);
    bench.harness.unmount();
  });

  test('resume under an open overlay keeps the view parked until the overlay closes', async () => {
    const bench = await heavyPane();
    await paused(bench);
    calls = [];
    occlusionListeners.forEach((fn) => fn([OVER_SLOT]));
    overlays = [OVER_SLOT];
    await settle();
    expect(names()).not.toContain('browser_screenshot');

    resumeByFocus(bench);
    await settle();
    expect(calls.filter((c) => c.cmd === 'browser_set_bounds' && c.args.x === SLOT.x)).toEqual([]);
    expect(names()).not.toContain('browser_screenshot');

    overlays = [];
    occlusionListeners.forEach((fn) => fn([]));
    await settle();
    expect(calls.filter((c) => c.cmd === 'browser_set_bounds' && c.args.x === SLOT.x)).toHaveLength(1);
    await advance(240);
    bench.harness.rerender();
    expect(bench.handle().frozenImage ?? null).toBeNull();
    bench.harness.unmount();
  });

  test('the tab sheet freezing a paused pane takes no screenshot of a hidden view', async () => {
    const bench = await heavyPane();
    await paused(bench);
    calls = [];
    bench.handle().freeze?.();
    await settle();
    expect(names()).not.toContain('browser_screenshot');
    bench.harness.unmount();
  });

  test('an agent op on a paused pane wakes it and leaves it hidden again', async () => {
    const bench = await heavyPane();
    await paused(bench);
    calls = [];
    const socket = sockets[sockets.length - 1]!;
    socket.emit('open');
    socket.emit('message', JSON.stringify({ type: 'browser_op', opId: 'op1', tool: 'browser_status', args: {} }));
    await settle();
    await advance(200);
    expect(visibility()).toEqual([true, false]);
    bench.harness.unmount();
  });

  test('a host reload mounts the pane live: the first visibility sent is true', async () => {
    const bench = await heavyPane();
    await paused(bench);
    bench.harness.unmount();
    calls = [];
    const again = mount(createElement(function Probe(): null {
      useTauriBrowser(CTX, 'https://example.com/', true);
      return null;
    }));
    await settle();
    expect(visibility()[0]).toBe(true);
    again.unmount();
  });

  test('a paused pane sent behind another tab stays hidden when its verdict drops', async () => {
    const bench = await heavyPane();
    await paused(bench);
    bench.props.isVisible = false;
    bench.harness.rerender();
    bench.handle().setBounds({ x: 0, y: 0, width: 0, height: 0 });
    await settle();
    calls = [];
    // A sibling mount of the same context unmounting drops the verdict.
    forgetPane(CTX);
    bench.harness.rerender();
    await advance(10_000);
    bench.harness.rerender();
    expect(bench.handle().paused).toBe(false);
    expect(visibility()).not.toContain(true);
    bench.harness.unmount();
  });

  test('the same drop from a new path read by the background poll leaves it hidden too', async () => {
    const bench = await heavyPane();
    await paused(bench);
    bench.props.isVisible = false;
    bench.harness.rerender();
    bench.handle().setBounds({ x: 0, y: 0, width: 0, height: 0 });
    await settle();
    calls = [];
    pageState = JSON.stringify({ u: 'https://example.com/login', t: 'Login', r: 'complete' });
    await advance(2_600);
    bench.harness.rerender();
    expect(bench.handle().url).toBe('https://example.com/login');
    noteWebviewSample([{ label: `browserpane-${CTX}`, pid: 4242, cpu_percent: 0 }], Date.now() + 120_000);
    bench.harness.rerender();
    await advance(10_000);
    bench.harness.rerender();
    expect(visibility()).not.toContain(true);
    bench.harness.unmount();
  });

  test('an inspector open when the dwell ends only postpones the pause', async () => {
    const bench = await heavyPane();
    inspectorOpen = true;
    bench.props.hasFocus = false;
    bench.harness.rerender();
    await advance(PAUSE_DWELL_MS);
    await advance(400);
    bench.harness.rerender();
    expect(bench.handle().paused).toBe(false);
    inspectorOpen = false;
    await advance(PAUSE_DWELL_MS);
    await advance(PAUSE_DWELL_MS);
    bench.harness.rerender();
    expect(bench.handle().paused).toBe(true);
    bench.harness.unmount();
  });

  test('an element in full screen keeps the pane live, and the pause comes after it leaves', async () => {
    const bench = await heavyPane();
    fullScreen = true;
    noteWindowFocusEvent(false);
    bench.harness.rerender();
    await advance(PAUSE_DWELL_MS * 3);
    bench.harness.rerender();
    expect(bench.handle().paused).toBe(false);
    expect(names()).not.toContain('browser_screenshot');
    fullScreen = false;
    await advance(PAUSE_DWELL_MS);
    await advance(PAUSE_DWELL_MS);
    bench.harness.rerender();
    expect(bench.handle().paused).toBe(true);
    bench.harness.unmount();
  });

  test('an agent at the wheel keeps the native drains running in an unfocused window', async () => {
    const bench = await heavyPane();
    const socket = sockets[sockets.length - 1]!;
    socket.emit('open');
    socket.emit('message', JSON.stringify({ type: 'agent_active', active: true, action: 'Click' }));
    bench.harness.rerender();
    await settle();
    noteWindowFocusEvent(false);
    calls = [];
    await advance(3_000);
    expect(names()).toContain('browser_take_new_tabs');
    expect(names()).toContain('browser_take_nav_state');
    expect(names()).toContain('browser_take_nav_errors');
    bench.harness.unmount();
  });
});
