/**
 * THE DOWNLOAD DRAIN SLEEPS WITH THE PANE, AND NOT WHILE A FILE IS ARRIVING.
 *
 * It was the one pane poll with no gate at all: a `browser_take_download_events`
 * every second for every browser pane, hidden, backgrounded or in an unfocused
 * window. Now it runs while the pane is wanted (on screen or used by an agent)
 * or a download is in flight, and catches up once when it is wanted again.
 *
 * @covers BROWSER-HEAVY-05
 */
import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll, mock, jest } from 'bun:test';
import { createElement } from 'react';
import { mount } from '../test/reactHarness';
import * as tauriShell from '../lib/shell/tauri';
import * as shell from '../lib/shell';
import { noteWindowFocusEvent } from '../lib/shell/windowFocus';

let calls: string[] = [];
let pendingEvents: unknown[] = [];

const realTauri = {
  tauriInvoke: tauriShell.tauriInvoke,
  currentWindowLabel: tauriShell.currentWindowLabel,
  releaseNativeFocus: tauriShell.releaseNativeFocus,
};
const realShell = {
  detectShell: shell.detectShell,
  shellKind: shell.shellKind,
  isTauri: shell.isTauri,
  isDesktop: shell.isDesktop,
  isTauriWindows: shell.isTauriWindows,
};

beforeAll(() => {
  mock.module('../lib/shell/tauri', () => ({
    ...realTauri,
    tauriInvoke: (cmd: string) => {
      calls.push(cmd);
      if (cmd === 'browser_take_download_events') {
        const out = pendingEvents;
        pendingEvents = [];
        return Promise.resolve(out);
      }
      return Promise.resolve([]);
    },
  }));
  mock.module('../lib/shell', () => ({ ...realShell, shellKind: 'tauri', isTauri: true, isDesktop: true }));
});

afterAll(() => {
  mock.module('../lib/shell/tauri', () => realTauri);
  mock.module('../lib/shell', () => realShell);
});

const { useBrowserDownloads } = await import('./useBrowserDownloads');

const g = globalThis as unknown as Record<string, unknown>;
const saved: Record<string, unknown> = {};

beforeEach(() => {
  jest.useFakeTimers();
  calls = [];
  pendingEvents = [];
  for (const k of ['window', 'document']) saved[k] = g[k];
  const target = { addEventListener() {}, removeEventListener() {} };
  g.window = { ...target, setInterval: (fn: () => void, ms?: number) => setInterval(fn, ms), clearInterval: (h: number) => clearInterval(h) };
  g.document = { ...target, visibilityState: 'visible', hidden: false };
  noteWindowFocusEvent(true);
});

afterEach(() => {
  jest.useRealTimers();
  for (const k of ['window', 'document']) {
    if (saved[k] === undefined) delete g[k]; else g[k] = saved[k];
  }
});

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function mountDownloads(wanted: { value: boolean }, agent = false) {
  return mount(createElement(function Probe(): null {
    useBrowserDownloads('ctx-dl', wanted.value, agent);
    return null;
  }));
}

const count = (cmd: string) => calls.filter((c) => c === cmd).length;

describe('useBrowserDownloads: the drain follows the pane', () => {
  test('no drain while the pane is not wanted, one catch-up the moment it is', async () => {
    const wanted = { value: false };
    const h = mountDownloads(wanted);
    jest.advanceTimersByTime(5_000);
    await settle();
    expect(count('browser_take_download_events')).toBe(0);

    wanted.value = true;
    h.rerender();
    await settle();
    expect(count('browser_take_download_events')).toBe(1);
    jest.advanceTimersByTime(3_000);
    await settle();
    expect(count('browser_take_download_events')).toBe(4);
    h.unmount();
  });

  test('a download in flight keeps the drain and its progress going after the pane leaves', async () => {
    const wanted = { value: true };
    const h = mountDownloads(wanted);
    pendingEvents = [{ kind: 'start', id: 'd1', url: 'https://example.com/f.zip', filename: 'f.zip', success: false, state: 'progressing', savedPath: '' }];
    jest.advanceTimersByTime(1_000);
    await settle();
    h.rerender();

    wanted.value = false;
    h.rerender();
    calls = [];
    jest.advanceTimersByTime(3_000);
    await settle();
    expect(count('browser_take_download_events')).toBe(3);
    expect(count('browser_download_progress')).toBe(3);
    h.unmount();
  });

  test('an unfocused window stops it even with the pane wanted', async () => {
    const wanted = { value: true };
    const h = mountDownloads(wanted);
    noteWindowFocusEvent(false);
    jest.advanceTimersByTime(5_000);
    await settle();
    expect(calls).toEqual([]);
    noteWindowFocusEvent(true);
    h.unmount();
  });

  test('an agent at the wheel keeps it running in an unfocused window', async () => {
    const h = mountDownloads({ value: true }, true);
    await settle();
    noteWindowFocusEvent(false);
    jest.advanceTimersByTime(3_000);
    await settle();
    expect(count('browser_take_download_events')).toBe(3);
    noteWindowFocusEvent(true);
    h.unmount();
  });
});
