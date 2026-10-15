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

// The page's serialized state can disagree with the native pane URL.
const realStringify = JSON.stringify;
const pageWorld: Record<string, unknown> = {};
pageWorld.window = pageWorld;
pageWorld.location = { href: 'https://pane.example/landing', origin: 'https://pane.example', protocol: 'https:' };
pageWorld.document = { title: 'Pane', readyState: 'complete', documentElement: { style: { zoom: '' } }, querySelector: () => null, hasFocus: () => true };
pageWorld.localStorage = { length: 1, key: () => 'own', getItem: () => 'v', setItem() {} };
pageWorld.addEventListener = () => {};
// Off for a page that reports itself honestly.
let forgePage = true;
pageWorld.JSON = {
  parse: JSON.parse,
  stringify(v: any, ...rest: any[]) {
    if (!forgePage) return realStringify(v, ...rest);
    if (v && typeof v === 'object' && 'u' in v) v = { ...v, u: 'https://other.example/account' };
    if (v && typeof v === 'object' && 'origin' in v && 'localStorage' in v) {
      v = { origin: 'https://other.example', localStorage: [{ name: 'session', value: 'other-origin-value' }] };
    }
    return realStringify(v, ...rest);
  },
};
const runInPage = new Function('pw', 'js', 'with (pw) { return eval(js); }') as (pw: unknown, js: string) => unknown;

let navState: Array<{ url: string; title: string; loading: boolean }> = [];
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
    tauriInvoke: (cmd: string, args?: { js?: string }) => {
      if (cmd === 'browser_take_nav_state') { const out = navState; navState = []; return Promise.resolve(out); }
      if (cmd === 'browser_take_nav_errors') return Promise.resolve([]);
      if (cmd === 'browser_pane_get_cookies') return Promise.resolve('[]');
      if (cmd === 'browser_eval_js' && typeof args?.js === 'string') {
        try { return Promise.resolve(String(runInPage(pageWorld, args.js) ?? '')); } catch (e) { return Promise.resolve(''); }
      }
      return Promise.resolve('');
    },
  }));
});
afterAll(() => { mock.module('../lib/shell/tauri', () => realTauri); });

const g = globalThis as unknown as Record<string, unknown>;
const saved: Record<string, unknown> = {};
const KEYS = ['window', 'document', 'WebSocket', 'requestAnimationFrame'] as const;
let intervals: Array<() => void> = [];
const sockets: FakeWs[] = [];
class FakeWs {
  static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSING = 2; static readonly CLOSED = 3;
  readyState = 0; sent: string[] = []; listeners: Record<string, Array<(e: any) => void>> = {};
  constructor(readonly url: string) { sockets.push(this); }
  addEventListener(t: string, fn: (e: any) => void) { (this.listeners[t] ??= []).push(fn); }
  removeEventListener() {}
  send(t: string) { this.sent.push(t); }
  close() { this.readyState = 3; }
  emit(t: string, e: any = {}) { for (const fn of this.listeners[t] ?? []) fn(e); }
}
function eventTarget(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...extra, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms), clearTimeout: (h: number) => clearTimeout(h),
    setInterval: (fn: () => void) => { intervals.push(fn); return intervals.length; }, clearInterval: () => {} };
}
const realNow = Date.now;
let offset = 0;
beforeEach(() => {
  noteWindowFocusEvent(true);
  forgePage = true;
  intervals = [];
  for (const k of KEYS) saved[k] = g[k];
  g.window = eventTarget({ location: { protocol: 'http:', host: '127.0.0.1:3333', href: 'http://127.0.0.1:3333/' } });
  g.document = eventTarget({ hidden: false, visibilityState: 'visible', querySelector: () => null, hasFocus: () => true });
  g.WebSocket = FakeWs;
  g.requestAnimationFrame = (fn: (t: number) => void) => { fn(0); return 1; };
  Date.now = () => realNow() + offset;
});
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete g[k]; else g[k] = saved[k]; } Date.now = realNow; });
async function settle() { for (let i = 0; i < 60; i++) await Promise.resolve(); }
async function tick() { for (const fn of [...intervals]) fn(); await settle(); }
async function saveState(ctx: string) {
  const ws = sockets.find((s) => s.url.includes(`/ws/browser/${ctx}`))!;
  ws.readyState = 1; ws.emit('open');
  ws.emit('message', { data: JSON.stringify({ type: 'browser_op', opId: 'op-1', tool: 'browser_save_state', args: { handle: 'h' } }) });
  for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 20)); await settle(); }
  return ws.sent.map((s) => JSON.parse(s)).find((f) => f.type === 'browser_op_result').result;
}
function mountPane(ctx: string, seen: NativeBrowserHandle[]) {
  return mount(createElement(function Surface(): null {
    seen.push(useTauriBrowser(ctx, 'https://pane.example/landing', true));
    return null;
  }));
}

describe('native pane saved state', () => {
  test('saved localStorage belongs only to the pane own origin', async () => {
    const seen: NativeBrowserHandle[] = [];
    const pane = mountPane('ctx-probe', seen);
    await settle();
    navState = [{ url: 'https://pane.example/landing', title: 'Pane', loading: false }];
    await tick();
    offset += 3000;
    await tick();
    const result = await saveState('ctx-probe');
    expect(seen.at(-1)!.url).toBe('https://other.example/account');
    expect(result.origins).toEqual([]);
    pane.unmount();
  });

  test('an honest page saves the localStorage of the origin the native view reports', async () => {
    forgePage = false;
    const seen: NativeBrowserHandle[] = [];
    const pane = mountPane('ctx-honest', seen);
    await settle();
    navState = [{ url: 'https://pane.example/landing', title: 'Pane', loading: false }];
    await tick();
    offset += 3000;
    await tick();
    const result = await saveState('ctx-honest');
    expect(result.origins).toEqual([{ origin: 'https://pane.example', localStorage: [{ name: 'own', value: 'v' }] }]);
    pane.unmount();
  });
});
