/**
 * AN OPEN OF A LIVE VIEW KEEPS ITS PAGE, AND SAYS WHERE IT IS.
 *
 * The shell's `browser_open` used to navigate a view that already existed
 * whenever the url it was given differed from the last url the client had
 * asked for: a ⌘R of the app, a remount that missed the client's handoff or a
 * pop-out reloaded the page and lost what was in it. It now reuses the view as
 * it is and answers `{ reused, url }` (lib.rs, `plan_browser_open`). Three
 * things follow on this side, pinned here:
 *
 *  - the address bar shows the url the shell reports for a reused view, not
 *    the stale one the pane asked for;
 *  - a caller that needs the view AT a url (`recreate`, the parked tab) sends
 *    the explicit `browser_navigate` when the view turns out to be alive;
 *  - the deferred close of a surface that let go of a view is conditional on
 *    the view still being in this window, so a pop-out that took the view over
 *    keeps it. And a pop-out marks this window's views as moving, so their
 *    closes wait for the new window to ask.
 *
 * @covers TOPIC-BROWSER-01
 */
import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll, mock } from 'bun:test';
import { createElement } from 'react';
import { mount } from '../test/reactHarness';
import * as tauriShell from '../lib/shell/tauri';
import * as occlusionModule from '../lib/shell/browserOcclusion';
import type { OverlayRect } from '../lib/shell/browserOcclusion';
import * as devTypes from '../components/Browser/browserDevTypes';
import * as paneContextModel from '../components/Browser/paneContextModel';
import * as browserNavUrl from '../lib/browserNavUrl';
import type { NativeBrowserHandle } from '../components/Browser/browserDevTypes';
import { beginNativeViewMovesToAnotherWindow } from '../lib/shell/nativeBrowserViews';

// Same alias registration as the other benches of this hook: `bun test` does not
// resolve `@/`, and the REAL hook is what has to be driven here.
mock.module('@/components/Browser/browserDevTypes', () => devTypes);
mock.module('@/components/Browser/paneContextModel', () => paneContextModel);
mock.module('@/lib/browserNavUrl', () => browserNavUrl);

const { useTauriBrowser } = await import('./useTauriBrowser');

/** Longer than `BROWSER_CLOSE_GRACE_MS` (350): a close that was only deferred
 *  would have reached the shell by then. */
const PAST_GRACE_MS = 450;

interface Invocation { cmd: string; args: Record<string, unknown> }

let invocations: Invocation[] = [];
/** What the shell answers to `browser_open` in this test ('' = an older shell). */
let openAnswer: unknown = '';
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
      if (cmd === 'browser_open') return Promise.resolve(openAnswer);
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
  openAnswer = '';
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

/** One pane hosting the page. */
function surface(contextId: string, url: string, seen: NativeBrowserHandle[], visible = true) {
  return mount(createElement(function Surface(): null {
    seen.push(useTauriBrowser(contextId, url, visible));
    return null;
  }));
}

function sent(contextId: string, cmd: string): Invocation[] {
  return invocations.filter((i) => i.cmd === cmd && i.args.id === contextId);
}

describe('useTauriBrowser: an open that finds the view alive', () => {
  test('the address bar shows where the reused page is, not the url the pane asked for', async () => {
    const ctx = 'ctx-reuse-url';
    openAnswer = { reused: true, url: 'https://example.com/inbox?after=login' };
    const seen: NativeBrowserHandle[] = [];
    const pane = surface(ctx, 'https://example.com/start', seen);
    await settle();
    expect(sent(ctx, 'browser_open')).toHaveLength(1);
    expect(seen[seen.length - 1]!.url).toBe('https://example.com/inbox?after=login');
    // The mount wants the live page: nothing navigates it.
    expect(sent(ctx, 'browser_navigate')).toEqual([]);
    pane.unmount();
  });

  test('an older shell answers nothing: the bar shows the requested url', async () => {
    const ctx = 'ctx-reuse-old-shell';
    const seen: NativeBrowserHandle[] = [];
    const pane = surface(ctx, 'https://example.com/start', seen);
    await settle();
    expect(seen[seen.length - 1]!.url).toBe('https://example.com/start');
    pane.unmount();
  });

  test('recreate onto a view that is still alive navigates it explicitly', async () => {
    const ctx = 'ctx-reuse-recreate';
    const seen: NativeBrowserHandle[] = [];
    const pane = surface(ctx, 'https://example.com/start', seen);
    await settle();
    invocations = [];
    // The close does not land (the shell keeps the label) and the reopen finds
    // the old view on another page.
    openAnswer = { reused: true, url: 'https://example.com/somewhere-else' };
    await seen[seen.length - 1]!.recreate!();
    await settle();
    expect(sent(ctx, 'browser_navigate').map((i) => i.args.url)).toEqual(['https://example.com/start']);
    expect(seen[seen.length - 1]!.url).toBe('https://example.com/start');
    pane.unmount();
  });
});

describe('useTauriBrowser: letting go of a view does not kill it in another window', () => {
  test('the deferred close after an unmount is conditional on this window', async () => {
    const ctx = 'ctx-release-conditional';
    const pane = surface(ctx, 'https://example.com/start', []);
    await settle();
    pane.unmount();
    await new Promise((r) => setTimeout(r, PAST_GRACE_MS));
    await settle();
    const closes = sent(ctx, 'browser_close');
    expect(closes).toHaveLength(1);
    expect(closes[0]!.args).toEqual({ id: ctx, hostWindow: 'main' });
  });

  test('a pop-out about to open parks the close of a page this window lets go of', async () => {
    const ctx = 'ctx-release-popout';
    const pane = surface(ctx, 'https://example.com/start', []);
    await settle();
    beginNativeViewMovesToAnotherWindow();
    pane.unmount();
    await new Promise((r) => setTimeout(r, PAST_GRACE_MS));
    await settle();
    // Still alive for the new window to ask for (it closes, conditionally,
    // only if the move expires: pinned in nativeBrowserViews.test.ts).
    expect(sent(ctx, 'browser_close')).toEqual([]);
  });

  test('a page let go of for a pop-out is asked for again, never adopted blind', async () => {
    const ctx = 'ctx-release-popout-back';
    const first = surface(ctx, 'https://example.com/start', []);
    await settle();
    beginNativeViewMovesToAnotherWindow();
    first.unmount();
    await new Promise((r) => setTimeout(r, PAST_GRACE_MS));
    await settle();
    // Meanwhile the pop-out took the view and was closed with it (a group's
    // «Riporta qui», a detached topic's window closed): nothing tells this
    // document. The pane comes back here inside the move timeout.
    invocations = [];
    const seen: NativeBrowserHandle[] = [];
    const again = surface(ctx, 'https://example.com/start', seen);
    await settle();
    // The shell is the only one that knows whether the view still exists, and
    // where: it keeps a live page and creates a destroyed one.
    expect(sent(ctx, 'browser_open')).toHaveLength(1);
    expect(seen[seen.length - 1]!.ready).toBe(true);
    // The parked close was taken by this mount: it never runs.
    expect(sent(ctx, 'browser_close')).toEqual([]);
    again.unmount();
  });
});
