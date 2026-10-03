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
import { beginNativeViewMove, closeNativeView, NATIVE_VIEW_MOVE_TIMEOUT_MS } from '../lib/shell/nativeBrowserViews';
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
      return Promise.resolve('');
    },
  }));
  mock.module('../lib/shell/browserOcclusion', () => ({
    ...realOcclusion,
    currentOverlays: () => [] as OverlayRect[],
    onOcclusionChange: (fn: (rects: OverlayRect[]) => void) => { fn([]); return () => {}; },
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
function surface(contextId: string, url: string, seen: NativeBrowserHandle[]) {
  return mount(createElement(function Surface(): null {
    seen.push(useTauriBrowser(contextId, url, true));
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
