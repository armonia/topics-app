/**
 * A TLS STRIP OVER A PAGE THAT WENT ON TO LOAD MUST NOT OUTLIVE IT.
 *
 * Reported 22/11 (task 590a3979): the pane showed "Connessione non sicura" over allow-italian: the UI string, quoted
 * `support.github.com` while the Support form behind it went through fine. The
 * strip only ever went out on a fresh `navigate()` call (the url bar, a WS
 * command) — a redirect the native view follows BY ITSELF (an OAuth hop that
 * crosses a failing leg, then lands) never cleared it, because nothing told the
 * client the page had moved on.
 *
 * Also covers the other half of that same gap: a native nav error must leave a
 * line in the server log (`POST /api/browsers/nav-error-log`), which is the only
 * way this class of failure was diagnosable at all — it happens on the Mac, not
 * on the server.
 *
 * The REAL hook is driven, same harness as `useTauriBrowser.history.test.ts`.
 *
 * @covers BROWSER-01
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

mock.module('@/components/Browser/browserDevTypes', () => devTypes);
mock.module('@/components/Browser/paneContextModel', () => paneContextModel);
mock.module('@/lib/browserNavUrl', () => browserNavUrl);

const { useTauriBrowser } = await import('./useTauriBrowser');

let navState: Array<{ url: string; title: string; loading: boolean }> = [];
let navErrors: Array<{ url: string; description: string; code: number; at?: number }> = [];

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
        const out = navState;
        navState = [];
        return Promise.resolve(out);
      }
      if (cmd === 'browser_take_nav_errors') {
        const out = navErrors;
        navErrors = [];
        return Promise.resolve(out);
      }
      if (cmd === 'browser_nav_entries') return Promise.resolve('');
      return Promise.resolve('');
    },
  }));
});

afterAll(() => {
  mock.module('../lib/shell/tauri', () => realTauri);
});

const g = globalThis as unknown as Record<string, unknown>;
const savedGlobals: Record<string, unknown> = {};
const DOM_KEYS = ['window', 'document', 'WebSocket', 'requestAnimationFrame', 'fetch'] as const;
let intervals: Array<() => void> = [];
/** Every `fetch` the hook fired, so the server-log call can be inspected without a real server. */
let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

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
  noteWindowFocusEvent(true);
  navState = [];
  navErrors = [];
  intervals = [];
  fetchCalls = [];
  for (const k of DOM_KEYS) savedGlobals[k] = g[k];
  g.window = eventTarget({ location: { protocol: 'http:', host: '127.0.0.1:3333', href: 'http://127.0.0.1:3333/' } });
  g.document = eventTarget({ hidden: false, visibilityState: 'visible', querySelector: () => null, hasFocus: () => true });
  g.WebSocket = SilentSocket;
  g.requestAnimationFrame = (fn: (t: number) => void) => { fn(0); return 1; };
  g.fetch = (url: string, init?: RequestInit) => {
    fetchCalls.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  };
});

afterEach(() => {
  for (const k of DOM_KEYS) {
    if (savedGlobals[k] === undefined) delete g[k]; else g[k] = savedGlobals[k];
  }
});

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

async function tick(): Promise<void> {
  for (const fn of [...intervals]) fn();
  await settle();
}

describe('useTauriBrowser: la striscia d\'errore nativo', () => {
  test('un TLS su un salto del redirect si spegne appena la pagina ne approda a un\'altra', async () => {
    const seen: NativeBrowserHandle[] = [];
    const pane = mount(createElement(function Surface(): null {
      seen.push(useTauriBrowser('ctx-github-support', 'https://support.github.com/contact', true));
      return null;
    }));
    await settle();

    // The OAuth hop fails with a TLS code the strip reports.
    navErrors = [{ url: 'https://github.com/login/oauth/authorize', description: 'This connection is not private.', code: -1202, at: Date.now() }];
    await tick();
    expect(seen.at(-1)!.navError?.message).toBeTruthy();
    expect(seen.at(-1)!.navError?.url).toContain('github.com/login/oauth');

    // Mirrored to the server log, pane+host+code+description, fire-and-forget.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toContain('/api/browsers/nav-error-log');
    const sent = JSON.parse(fetchCalls[0]!.init!.body as string);
    expect(sent).toMatchObject({ host: 'github.com', code: -1202, description: 'This connection is not private.' });

    // The native view itself moved on: a later leg lands on help.github.com.
    navState = [{ url: 'https://help.github.com/request/landing', title: 'GitHub Support', loading: false }];
    await tick();
    expect(seen.at(-1)!.navError).toBeNull();
    pane.unmount();
  });
});
