/**
 * THE WHITE RECTANGLE THAT STAYS IN FRONT (reported 23/09: "a volte i browser si
 * buggano e lasciano tipo un canvas bianco avanti").
 *
 * THE PATH. A pane on a LOCAL port is shown, then the layout remounts it (the
 * project auto-split re-keys it, or a group change) while that port has died.
 * The cleanup queues a deferred close; the remount cancels it and REUSES the
 * still-alive native view; then the loopback probe says "dead" and the pane is
 * parked, so `browser_open` never runs and the panel draws the ParkedPane card
 * with no placeholder. Nobody hides the reused view: `openedRef` was reset by
 * the cleanup, so the zero-rect branch skips the off-screen park, and the view
 * stays painted at its old rect, above the DOM, until `browser_claim` (tens of
 * seconds) or forever while the pane keeps it claimed.
 *
 * WHAT IS ASSERTED. Only the commands the shell receives: after the dead probe,
 * the reused view must be sent off-screen or hidden or closed. Before the fix
 * it received nothing.
 *
 * @covers NATIVEPARK-01
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

interface Invocation { cmd: string; args: Record<string, unknown> }

let invocations: Invocation[] = [];
/** Commands the shell should refuse, by name. */
let refuse = new Set<string>();

const realTauri = {
  tauriInvoke: tauriShell.tauriInvoke,
  currentWindowLabel: tauriShell.currentWindowLabel,
  releaseNativeFocus: tauriShell.releaseNativeFocus,
};
// Enumerated rather than spread (`{ ...occlusionModule }`): a namespace spread
// makes the module OPAQUE to knip, which then counts every export as used and
// stops seeing the dead ones. That is the blind spot `check:deadcode-blindspots`
// refuses, and it is the shape `realTauri` uses ten lines above. The price is
// that a new export has to be added here too; if it is not, the mock leaves it
// out and the test that uses it fails loudly, which is the right way to find out.
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

/** The overlay feed, driven by the test instead of by a MutationObserver. */
let overlays: readonly OverlayRect[] = [];
let occlusionListeners = new Set<(rects: OverlayRect[]) => void>();

beforeAll(() => {
  mock.module('../lib/shell/tauri', () => ({
    ...realTauri,
    currentWindowLabel: () => 'main',
    releaseNativeFocus: () => {},
    tauriInvoke: (cmd: string, args: Record<string, unknown> = {}) => {
      invocations.push({ cmd, args });
      if (refuse.has(cmd)) return Promise.reject(new Error(`shell refused ${cmd}`));
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



let portListening = true;

describe('useTauriBrowser: a reused view on a dead local port does not stay on screen', () => {
  test('remount + dead probe hides the view it reused', async () => {
    const realFetch = g.fetch;
    g.fetch = (async (u: string) => {
      if (String(u).includes('/api/browsers/port-listening')) {
        return { ok: true, json: async () => ({ listening: portListening }) };
      }
      return { ok: false, json: async () => ({}) };
    }) as unknown;
    try {
      portListening = true;
      const seen: NativeBrowserHandle[] = [];
      function Probe(): null {
        seen.push(useTauriBrowser('ctx-dead-port', 'http://localhost:5173/', true));
        return null;
      }
      const first = mount(createElement(Probe));
      await settle();
      seen[seen.length - 1]!.setBounds(SHOWN);
      await settle();
      expect(invocations.some((i) => i.cmd === 'browser_open')).toBe(true);

      // The port dies, then the layout remounts the pane inside the close grace.
      portListening = false;
      first.unmount();
      invocations = [];
      const second = mount(createElement(Probe));
      await settle();
      await new Promise((r) => setTimeout(r, 20));
      await settle();

      // The pane is parked, so no new view is opened...
      expect(invocations.some((i) => i.cmd === 'browser_open')).toBe(false);
      // ...so something must take it off the screen.
      const cleared = invocations.some((i) =>
        (i.cmd === 'browser_set_visible' && i.args.visible === false)
        || (i.cmd === 'browser_set_bounds' && Number(i.args.x) <= -100000)
        || i.cmd === 'browser_close');
      expect(cleared, 'the reused view is still painted at its old rect').toBe(true);
      second.unmount();
    } finally {
      g.fetch = realFetch;
    }
  });

  test('after a reload (no queued close) the dead-port mount still clears a surviving view', async () => {
    const realFetch = g.fetch;
    g.fetch = (async () => ({ ok: true, json: async () => ({ listening: false }) })) as unknown;
    try {
      invocations = [];
      function Probe(): null {
        useTauriBrowser('ctx-after-reload', 'http://localhost:4000/', true);
        return null;
      }
      const h = mount(createElement(Probe));
      await settle();
      await new Promise((r) => setTimeout(r, 20));
      await settle();
      expect(invocations.some((i) => i.cmd === 'browser_open')).toBe(false);
      expect(invocations.some((i) => i.cmd === 'browser_close' && i.args.id === 'ctx-after-reload')).toBe(true);
      h.unmount();
    } finally {
      g.fetch = realFetch;
    }
  });
});
