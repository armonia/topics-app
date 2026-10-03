/**
 * A MOVE IS NOT AN OPEN (reported 03/10: moving a topic's minimized browser
 * into a tab reloaded everything, as if the session had not moved with it).
 *
 * THE PATH. «Open as tab» on a topic's browser window hands the SAME contextId
 * to the layout: the sheet in the window unmounts and the layout's pane mounts
 * (in either order, inside one gesture). The cleanup of the first queues a
 * deferred close and the mount of the second cancels it, so the native view
 * survives. But the second mount then called `browser_open` again, and the
 * shell's reuse branch (`browser_open_inner`, lib.rs) NAVIGATES whenever the
 * url it is given differs from the last url the client ASKED for. The pane
 * mounts with its persisted url, which is the LIVE one (`onUrlChange`): after
 * any click, redirect or pushState inside the page the two differ, and the
 * move reloaded the page. Same view, same cookies, everything else gone.
 *
 * WHAT IS ASSERTED. Only what the shell receives across the move: no create,
 * no close, no navigation, and the view re-anchored to the new slot under the
 * same id. On origin/main the second mount sends `browser_open`.
 *
 * Two ways that adoption went wrong, pinned below. A REAL close sent straight
 * from a close funnel (not the hook's deferred one) left the id recorded, and a
 * reopen inside the grace adopted a destroyed view: an empty pane. And a pane
 * that mounted after the grace (a project creates it after a microtask, an
 * await and a Suspense) lost the race to the deferred close: the move became
 * close + open again, unless the move is a handoff (`beginNativeViewMove`).
 *
 * @covers TOPIC-BROWSER-01
 */
import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll, mock, jest } from 'bun:test';
import { createElement } from 'react';
import { mount } from '../test/reactHarness';
import * as tauriShell from '../lib/shell/tauri';
import * as occlusionModule from '../lib/shell/browserOcclusion';
import type { OverlayRect } from '../lib/shell/browserOcclusion';
import * as devTypes from '../components/Browser/browserDevTypes';
import * as paneContextModel from '../components/Browser/paneContextModel';
import * as browserNavUrl from '../lib/browserNavUrl';
import type { NativeBrowserHandle } from '../components/Browser/browserDevTypes';
import { beginNativeViewMove, closeNativeView, isNativeViewOpened, NATIVE_VIEW_MOVE_TIMEOUT_MS } from '../lib/shell/nativeBrowserViews';
import { teardownNativeBrowserPane } from '../lib/nativeBrowserTeardown';

// Same alias registration as the other benches of this hook: `bun test` does not
// resolve `@/`, and the REAL hook is what has to be driven here.
mock.module('@/components/Browser/browserDevTypes', () => devTypes);
mock.module('@/components/Browser/paneContextModel', () => paneContextModel);
mock.module('@/lib/browserNavUrl', () => browserNavUrl);

const { useTauriBrowser } = await import('./useTauriBrowser');

/** Where the sheet sat, inside the topic's floating window. */
const IN_WINDOW = { x: 880, y: 420, width: 380, height: 260 };
/** Where the same page lands as a tab of the layout. */
const IN_TAB = { x: 320, y: 64, width: 900, height: 700 };
/** Longer than `BROWSER_CLOSE_GRACE_MS` (350): a close that was only deferred
 *  would have reached the shell by then. */
const PAST_GRACE_MS = 450;

/** Commands that cost the page: a new view, a dead view, a new document. */
const DESTRUCTIVE = ['browser_open', 'browser_close', 'browser_navigate', 'browser_reload', 'browser_purge_cache'];

interface Invocation { cmd: string; args: Record<string, unknown> }

let invocations: Invocation[] = [];
/** While true, `browser_open` answers only when the test releases it, in order. */
let holdOpens = false;
let heldOpens: Array<() => void> = [];
/** Overlays open over the window right now, and who is told when they change. */
let overlays: OverlayRect[] = [];
let occlusionListeners = new Set<(rects: OverlayRect[]) => void>();

const realTauri = {
  tauriInvoke: tauriShell.tauriInvoke,
  currentWindowLabel: tauriShell.currentWindowLabel,
  releaseNativeFocus: tauriShell.releaseNativeFocus,
};
// Enumerated, not spread: see the same note in `useTauriBrowser.park.test.ts`.
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
      invocations.push({ cmd, args });
      if (cmd === 'browser_open' && holdOpens) return new Promise((resolve) => { heldOpens.push(() => resolve('')); });
      return Promise.resolve('');
    },
  }));
  // The real decision (`decideFreeze`) is kept; only the overlay feed, a
  // body-wide MutationObserver in production, is driven by the test.
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
  holdOpens = false;
  heldOpens = [];
  overlays = [];
  occlusionListeners = new Set();
  for (const k of DOM_KEYS) savedGlobals[k] = g[k];
  g.window = eventTarget({ location: { protocol: 'http:', host: '127.0.0.1:3333', href: 'http://127.0.0.1:3333/' } });
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

/** One surface hosting the page: the window's sheet, or the layout's tab. */
function surface(contextId: string, url: string, seen: NativeBrowserHandle[], visible = true) {
  return mount(createElement(function Surface(): null {
    seen.push(useTauriBrowser(contextId, url, visible));
    return null;
  }));
}

/** Open the page in the window, as it is before the gesture: created once,
 *  placed in the window, then browsed away from the url it was opened on. */
async function openInWindow(contextId: string) {
  const seen: NativeBrowserHandle[] = [];
  const sheet = surface(contextId, 'https://example.com/start', seen);
  await settle();
  seen[seen.length - 1]!.setBounds(IN_WINDOW);
  await settle();
  expect(invocations.filter((i) => i.cmd === 'browser_open')).toHaveLength(1);
  invocations = [];
  return sheet;
}

/** What reached the shell for this page that would cost it its document. */
function destructive(contextId: string): string[] {
  return invocations
    .filter((i) => DESTRUCTIVE.includes(i.cmd) && i.args.id === contextId)
    .map((i) => i.cmd);
}

describe('useTauriBrowser: moving a live page to another surface keeps it', () => {
  test('sheet unmounts, then the tab mounts: no create, no close, no navigation', async () => {
    const ctx = 'ctx-move-after';
    const sheet = await openInWindow(ctx);

    // The gesture. The tab mounts with the url the window persisted, which is
    // where the page IS now, not where it was opened.
    sheet.unmount();
    const seen: NativeBrowserHandle[] = [];
    const tab = surface(ctx, 'https://example.com/inbox?after=login', seen);
    await settle();
    seen[seen.length - 1]!.setBounds(IN_TAB);
    await settle();
    await new Promise((r) => setTimeout(r, PAST_GRACE_MS));
    await settle();

    expect(destructive(ctx), 'the move recreated, closed or reloaded the page').toEqual([]);
    // Re-anchored, under the same identity: the view now sits in the tab.
    const placed = invocations.filter((i) => i.cmd === 'browser_set_bounds' && i.args.id === ctx);
    expect(placed.at(-1)?.args).toMatchObject({ x: IN_TAB.x, y: IN_TAB.y, width: IN_TAB.width, height: IN_TAB.height });
    expect(seen[seen.length - 1]!.ready).toBe(true);
    tab.unmount();
  });

  test('the tab mounts before the sheet lets go: still one view, untouched', async () => {
    const ctx = 'ctx-move-overlap';
    const sheet = await openInWindow(ctx);

    const seen: NativeBrowserHandle[] = [];
    const tab = surface(ctx, 'https://example.com/inbox?after=login', seen);
    sheet.unmount();
    await settle();
    seen[seen.length - 1]!.setBounds(IN_TAB);
    await settle();
    await new Promise((r) => setTimeout(r, PAST_GRACE_MS));
    await settle();

    expect(destructive(ctx), 'the move recreated, closed or reloaded the page').toEqual([]);
    expect(seen[seen.length - 1]!.ready).toBe(true);
    tab.unmount();
  });

  test('a real close is still a close: nobody remounts, the view goes after the grace', async () => {
    const ctx = 'ctx-move-closed';
    const sheet = await openInWindow(ctx);
    sheet.unmount();
    await new Promise((r) => setTimeout(r, PAST_GRACE_MS));
    await settle();
    expect(destructive(ctx)).toEqual(['browser_close']);

    // And the next mount after that close is an OPEN, not a reuse of a view
    // that no longer exists.
    invocations = [];
    const seen: NativeBrowserHandle[] = [];
    const again = surface(ctx, 'https://example.com/start', seen);
    await settle();
    expect(destructive(ctx)).toEqual(['browser_open']);
    again.unmount();
  });
  /** The shell closed this view: the next pane under the id must CREATE one. */
  async function reopenAfterDirectClose(ctx: string, directClose: (id: string) => void): Promise<string[]> {
    const sheet = await openInWindow(ctx);
    directClose(ctx);
    sheet.unmount();
    await new Promise((r) => setTimeout(r, 100));
    invocations = [];
    const seen: NativeBrowserHandle[] = [];
    const again = surface(ctx, 'https://example.com/start', seen);
    await settle();
    const sent = destructive(ctx);
    again.unmount();
    return sent;
  }

  const invoke = (cmd: string, args?: Record<string, unknown>) => tauriShell.tauriInvoke(cmd, args);

  test('a tab closed for real and reopened inside the grace opens a new view (close funnels)', async () => {
    // usePanelLifecycle and useProjectLayout close through `closeNativeView`.
    const sent = await reopenAfterDirectClose('ctx-direct-close', (id) => { void closeNativeView(id, invoke); });
    expect(sent, 'adopted a view the shell had already closed').toContain('browser_open');
  });

  test('a tab closed for real through the pane teardown is not adopted either', async () => {
    // usePaneLifecycle closes through `teardownNativeBrowserPane`.
    const sent = await reopenAfterDirectClose('ctx-teardown-close', (id) => teardownNativeBrowserPane(id, invoke));
    expect(sent, 'adopted a view the shell had already closed').toContain('browser_open');
  });

  test('a close while a sibling still holds the id: the next pane opens, not adopts', async () => {
    const ctx = 'ctx-direct-close-sibling';
    const sheet = await openInWindow(ctx);
    const sibling = surface(ctx, 'https://example.com/start', []);
    await settle();
    void closeNativeView(ctx, invoke);
    sheet.unmount();
    invocations = [];
    const again = surface(ctx, 'https://example.com/start', []);
    await settle();
    expect(destructive(ctx)).toContain('browser_open');
    again.unmount();
    sibling.unmount();
  });

  test('a handed-over move survives a pane that mounts two seconds late', async () => {
    const ctx = 'ctx-move-late';
    const sheet = await openInWindow(ctx);

    // What «open as tab» does before the layout's pane exists.
    beginNativeViewMove(ctx);
    sheet.unmount();
    await new Promise((r) => setTimeout(r, 2000));
    const seen: NativeBrowserHandle[] = [];
    const tab = surface(ctx, 'https://example.com/inbox?after=login', seen);
    await settle();
    seen[seen.length - 1]!.setBounds(IN_TAB);
    await settle();
    await new Promise((r) => setTimeout(r, PAST_GRACE_MS));
    await settle();

    expect(destructive(ctx), 'the late move recreated, closed or reloaded the page').toEqual([]);
    expect(seen[seen.length - 1]!.ready).toBe(true);
    tab.unmount();
  }, 10_000);

  test('a move nobody lands still closes the view, after the safety timeout', async () => {
    const ctx = 'ctx-move-lost';
    const sheet = await openInWindow(ctx);
    jest.useFakeTimers();
    try {
      beginNativeViewMove(ctx);
      sheet.unmount();
      jest.advanceTimersByTime(NATIVE_VIEW_MOVE_TIMEOUT_MS - 1);
      await settle();
      expect(destructive(ctx), 'closed before the move had time to land').toEqual([]);
      jest.advanceTimersByTime(1);
      await settle();
      expect(destructive(ctx), 'a lost move leaked its webview').toEqual(['browser_close']);
    } finally {
      jest.useRealTimers();
    }
  });
});

/** What the shell has been told about one view: its visibility and its rect. */
interface ViewState { visible: boolean; x: number; y: number; width: number; height: number }

const onScreen = (v: ViewState): boolean => v.visible && v.x > -100000;

/**
 * Replay what reached the shell for `id`, from a known state, and report every
 * state in which the view was PAINTED (visible and on-screen), plus whether a
 * screenshot was asked of it while it was hidden (a blank still).
 */
function replay(id: string, from: ViewState) {
  const state = { ...from };
  const painted: ViewState[] = onScreen(state) ? [{ ...state }] : [];
  let shotWhileHidden = false;
  for (const { cmd, args } of invocations) {
    if (args.id !== id) continue;
    if (cmd === 'browser_set_visible') state.visible = args.visible === true;
    else if (cmd === 'browser_set_bounds') {
      Object.assign(state, { x: Number(args.x), y: Number(args.y), width: Number(args.width), height: Number(args.height) });
    } else if (cmd === 'browser_screenshot') {
      if (!state.visible) shotWhileHidden = true;
      continue;
    } else continue;
    if (onScreen(state)) painted.push({ ...state });
  }
  return { painted, shotWhileHidden, final: state };
}

/** The view as the sheet left it: shown, on the window's rect. */
const SHOWN_IN_WINDOW: ViewState = { visible: true, ...IN_WINDOW };

describe('useTauriBrowser: a page in the middle of a move is not painted where it was', () => {
  /** Open in the window, start the move, let the sheet go: the view is now held by nobody. */
  async function letGo(ctx: string): Promise<void> {
    const sheet = await openInWindow(ctx);
    beginNativeViewMove(ctx);
    sheet.unmount();
    await settle();
  }

  test('the sheet that lets go hides the view at once, not after the move', async () => {
    const ctx = 'ctx-ghost-park';
    await letGo(ctx);
    const { painted, final } = replay(ctx, SHOWN_IN_WINDOW);
    expect(final.visible, 'the parked view is still visible').toBe(false);
    expect(painted.slice(1), 'the parked view was painted again after the sheet let go').toEqual([]);
    expect(onScreen(final), 'the parked view stays painted on the rect the sheet gave up').toBe(false);
    // Nobody arrives: the close still runs as before, at the safety timeout.
    expect(destructive(ctx)).toEqual([]);
  });

  test('adopted by a visible tab: painted again only on the tab, never on the old rect', async () => {
    const ctx = 'ctx-ghost-adopt';
    await letGo(ctx);
    const seen: NativeBrowserHandle[] = [];
    const tab = surface(ctx, 'https://example.com/inbox?after=login', seen);
    await settle();
    seen[seen.length - 1]!.setBounds(IN_TAB);
    await settle();

    const { painted, final } = replay(ctx, SHOWN_IN_WINDOW);
    expect(painted.slice(1).map(({ x, y }) => ({ x, y })), 'shown somewhere other than the tab').toEqual(
      painted.slice(1).map(() => ({ x: IN_TAB.x, y: IN_TAB.y })),
    );
    expect(painted.length, 'shown on the old rect after the sheet let go').toBeGreaterThan(1);
    expect(final).toMatchObject({ visible: true, ...IN_TAB });
    expect(destructive(ctx)).toEqual([]);
    tab.unmount();
  });

  test('adopted by a tab that is not visible: it stays hidden, and off the old rect', async () => {
    const ctx = 'ctx-ghost-hidden';
    await letGo(ctx);
    const seen: NativeBrowserHandle[] = [];
    const tab = surface(ctx, 'https://example.com/inbox?after=login', seen, false);
    await settle();
    // What the placeholder pushes for a pane that is not shown.
    seen[seen.length - 1]!.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    await settle();

    const { painted, final } = replay(ctx, SHOWN_IN_WINDOW);
    expect(painted.slice(1), 'a pane that is not visible painted the page').toEqual([]);
    expect(final.visible).toBe(false);
    tab.unmount();
  });

  test('adopted under an open overlay: not painted until it closes, and its still is not blank', async () => {
    const ctx = 'ctx-ghost-overlay';
    await letGo(ctx);
    // A menu open over the tab's slot when the page arrives.
    overlays = [{ left: IN_TAB.x, top: IN_TAB.y, right: IN_TAB.x + 200, bottom: IN_TAB.y + 200 }];
    const seen: NativeBrowserHandle[] = [];
    const tab = surface(ctx, 'https://example.com/inbox?after=login', seen);
    await settle();
    seen[seen.length - 1]!.setBounds(IN_TAB);
    await settle();
    await new Promise((r) => setTimeout(r, 50));
    await settle();

    const covered = replay(ctx, SHOWN_IN_WINDOW);
    expect(covered.painted.slice(1), 'painted over the overlay, or on the old rect').toEqual([]);
    expect(invocations.some((i) => i.cmd === 'browser_screenshot' && i.args.id === ctx), 'no freeze under the overlay').toBe(true);
    expect(covered.shotWhileHidden, 'the still under the overlay was taken of a hidden view').toBe(false);

    // The menu closes: the page comes back, on the tab.
    overlays = [];
    for (const fn of occlusionListeners) fn([]);
    await settle();
    const after = replay(ctx, SHOWN_IN_WINDOW);
    expect(after.final).toMatchObject({ visible: true, ...IN_TAB });
    tab.unmount();
  });
});

describe('useTauriBrowser: a close that overtakes browser_open wins', () => {
  const invoke = (cmd: string, args?: Record<string, unknown>) => tauriShell.tauriInvoke(cmd, args);

  test('closed while opening: the late view is closed, and a reopen inside the grace opens', async () => {
    const ctx = 'ctx-open-overtaken';
    holdOpens = true;
    const pane = surface(ctx, 'https://example.com/start', []);
    await settle();
    expect(destructive(ctx)).toEqual(['browser_open']);

    // The close countdown, or an agent's close-pane over the socket, while the
    // shell is still creating the view.
    void closeNativeView(ctx, invoke);
    await settle();
    heldOpens.shift()!();
    await settle();

    expect(isNativeViewOpened(ctx), 'the late open put back a view the close had taken out').toBe(false);
    expect(destructive(ctx), 'the view the late open produced was left alive').toEqual(['browser_open', 'browser_close', 'browser_close']);

    // The pane leaves with that close and is reopened inside the close grace.
    pane.unmount();
    holdOpens = false;
    invocations = [];
    const again = surface(ctx, 'https://example.com/start', []);
    await settle();
    expect(destructive(ctx), 'adopted a view the shell had already closed').toEqual(['browser_open']);
    again.unmount();
  });

  test('unmounted while opening, its close ran first: the view that appears after is closed', async () => {
    const ctx = 'ctx-open-orphan';
    holdOpens = true;
    const pane = surface(ctx, 'https://example.com/start', []);
    await settle();
    pane.unmount();
    // The deferred close leaves while the shell is still creating the view.
    await new Promise((r) => setTimeout(r, PAST_GRACE_MS));
    await settle();
    expect(destructive(ctx)).toEqual(['browser_open', 'browser_close']);

    heldOpens.shift()!();
    await settle();
    expect(destructive(ctx), 'a view born after its close has no owner left to close it').toEqual(['browser_open', 'browser_close', 'browser_close']);
    expect(isNativeViewOpened(ctx)).toBe(false);
  });
});

describe('useTauriBrowser: adoption is decided again when it happens', () => {
  const invoke = (cmd: string, args?: Record<string, unknown>) => tauriShell.tauriInvoke(cmd, args);

  test('a view closed during the loopback probe is not adopted: the pane opens a new one', async () => {
    const ctx = 'ctx-adopt-probe';
    // The probe of a local port, held until the test answers it.
    let answerProbe: (listening: boolean) => void = () => {};
    const realFetch = g.fetch;
    g.fetch = ((u: string) => {
      if (!String(u).includes('/api/browsers/port-listening')) return Promise.resolve({ ok: false, json: async () => ({}) });
      return new Promise((resolve) => {
        answerProbe = (listening) => resolve({ ok: true, json: async () => ({ listening }) });
      });
    }) as unknown;
    try {
      const sheet = await openInWindow(ctx);
      beginNativeViewMove(ctx);
      sheet.unmount();
      await settle();
      // The tab takes the move at mount, on a local url: it waits for the probe.
      const seen: NativeBrowserHandle[] = [];
      const tab = surface(ctx, 'http://localhost:5173/app', seen);
      await settle();
      expect(destructive(ctx)).toEqual([]);

      // Meanwhile another pane closes the page (a close funnel, the countdown).
      void closeNativeView(ctx, invoke);
      await settle();
      answerProbe(true);
      await settle();

      expect(destructive(ctx), 'adopted a view another pane had closed').toEqual(['browser_close', 'browser_open']);
      expect(seen[seen.length - 1]!.ready).toBe(true);
      tab.unmount();
    } finally {
      g.fetch = realFetch;
    }
  });
});
