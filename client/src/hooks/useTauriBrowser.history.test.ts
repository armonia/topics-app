/**
 * THE ‹ OF A NATIVE PANE LIGHTS UP WHEN THERE IS HISTORY BEHIND THE PAGE.
 *
 * Reported on 2026-10-04 that back seemed not to work:
 * «l'indietro sembra non funzionale» (allow-italian: the report, verbatim). The arrows'
 * state was refreshed on the `loading` edge alone, and the most common
 * navigation never makes one: the shell coalesces its KVO state to the latest
 * per pane, so a link that loads inside one 250 ms drain arrives as
 * `loading: false` straight away, and a `pushState` never loads at all. The
 * back-forward list had grown, and ‹ stayed disabled in the tab's sheet and in
 * the context menu.
 *
 * And on Windows WebView2 exposes no history list, only `CanGoBack` /
 * `CanGoForward`: an arrow derived from the (always empty) list was disabled
 * for good. The shell now sends the two flags and the client reads them.
 *
 * The REAL hook is driven, with the shell's IPC answered by the test.
 *
 * @covers BROWSER-BACK-02
 */
import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll, mock } from 'bun:test';
import { createElement } from 'react';
import { mount } from '../test/reactHarness';
import * as tauriShell from '../lib/shell/tauri';
import { noteWindowFocusEvent } from '../lib/shell/windowFocus';
import * as devTypes from '../components/Browser/browserDevTypes';
import * as paneContextModel from '../components/Browser/paneContextModel';
import * as browserNavUrl from '../lib/browserNavUrl';
import type { NativeBrowserHandle } from '../components/Browser/browserDevTypes';

// Same alias registration as the other benches of this hook: `bun test` does
// not resolve `@/`.
mock.module('@/components/Browser/browserDevTypes', () => devTypes);
mock.module('@/components/Browser/paneContextModel', () => paneContextModel);
mock.module('@/lib/browserNavUrl', () => browserNavUrl);

const { useTauriBrowser } = await import('./useTauriBrowser');
const { parseNavHistory } = await import('./parseNavHistory');

/** What the shell answers right now. */
let navState: Array<{ url: string; title: string; loading: boolean }> = [];
let navEntries = '';

const realTauri = {
  tauriInvoke: tauriShell.tauriInvoke,
  currentWindowLabel: tauriShell.currentWindowLabel,
  releaseNativeFocus: tauriShell.releaseNativeFocus,
};

beforeAll(() => {
  mock.module('../lib/shell/tauri', () => ({
    ...realTauri,
    currentWindowLabel: () => 'main',
    releaseNativeFocus: () => {},
    tauriInvoke: (cmd: string) => {
      if (cmd === 'browser_take_nav_state') {
        // A drain hands its queue over once, like the shell's.
        const out = navState;
        navState = [];
        return Promise.resolve(out);
      }
      if (cmd === 'browser_nav_entries') return Promise.resolve(navEntries);
      if (cmd === 'browser_take_nav_errors') return Promise.resolve([]);
      return Promise.resolve('');
    },
  }));
});

afterAll(() => {
  mock.module('../lib/shell/tauri', () => realTauri);
});

const g = globalThis as unknown as Record<string, unknown>;
const savedGlobals: Record<string, unknown> = {};
const DOM_KEYS = ['window', 'document', 'WebSocket', 'requestAnimationFrame'] as const;
/** Every periodic tick the hook armed, fired by hand. */
let intervals: Array<() => void> = [];

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
    setInterval: (fn: () => void) => { intervals.push(fn); return intervals.length; },
    clearInterval: () => {},
  };
}

beforeEach(() => {
  // The window-focus store is module state: a bench that ran before this file
  // may have left it unfocused, which gates every drain of the pane off.
  noteWindowFocusEvent(true);
  navState = [];
  navEntries = '';
  intervals = [];
  for (const k of DOM_KEYS) savedGlobals[k] = g[k];
  g.window = eventTarget({ location: { protocol: 'http:', host: '127.0.0.1:3333', href: 'http://127.0.0.1:3333/' } });
  g.document = eventTarget({ hidden: false, visibilityState: 'visible', querySelector: () => null, hasFocus: () => true });
  g.WebSocket = SilentSocket;
  g.requestAnimationFrame = (fn: (t: number) => void) => { fn(0); return 1; };
});

afterEach(() => {
  for (const k of DOM_KEYS) {
    if (savedGlobals[k] === undefined) delete g[k]; else g[k] = savedGlobals[k];
  }
});

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

/** One round of every periodic tick, then let the IPC answers land. */
async function tick(): Promise<void> {
  for (const fn of [...intervals]) fn();
  await settle();
}

const history = (urls: string[], active: number) =>
  JSON.stringify({ entries: urls.map((url) => ({ url, title: url })), activeIndex: active });

describe('useTauriBrowser: ‹ follows the back-forward list', () => {
  test('a link that loaded inside one drain lights ‹ up, with no loading edge in between', async () => {
    const seen: NativeBrowserHandle[] = [];
    const pane = mount(createElement(function Surface(): null {
      seen.push(useTauriBrowser('ctx-back-link', 'https://example.com/a', true));
      return null;
    }));
    await settle();

    // The first page, loaded: nothing behind it.
    navEntries = history(['https://example.com/a'], 0);
    navState = [{ url: 'https://example.com/a', title: 'A', loading: false }];
    await tick();
    expect(seen.at(-1)!.url).toBe('https://example.com/a');
    expect(seen.at(-1)!.canGoBack).toBe(false);

    // A click on a link: the whole load fits in one drain, so the coalesced
    // state the shell hands over is already `loading: false`.
    navEntries = history(['https://example.com/a', 'https://example.com/b'], 1);
    navState = [{ url: 'https://example.com/b', title: 'B', loading: false }];
    await tick();
    await tick();
    expect(seen.at(-1)!.url).toBe('https://example.com/b');
    expect(seen.at(-1)!.canGoBack).toBe(true);
    expect(seen.at(-1)!.canGoForward).toBe(false);
    pane.unmount();
  });
});

describe('parseNavHistory: the arrows from what the shell says', () => {
  test('WebView2 sends no list but its two flags, and the flags win', () => {
    const out = parseNavHistory(JSON.stringify({ entries: [], activeIndex: 0, canGoBack: true, canGoForward: false }));
    expect(out.entries).toEqual([]);
    expect(out.canGoBack).toBe(true);
    expect(out.canGoForward).toBe(false);
  });

  test('without flags the list decides: one entry behind, one ahead', () => {
    const out = parseNavHistory(history(['https://a.test/1', 'https://a.test/2', 'https://a.test/3'], 1));
    expect(out.entries.map((e) => e.index)).toEqual([0, 1, 2]);
    expect(out.canGoBack).toBe(true);
    expect(out.canGoForward).toBe(true);
  });

  test('an empty or broken answer is no history, never a throw', () => {
    for (const raw of ['', 'not json', 'null']) {
      const out = parseNavHistory(raw);
      expect(out).toEqual({ entries: [], activeIndex: 0, canGoBack: false, canGoForward: false });
    }
  });
});
