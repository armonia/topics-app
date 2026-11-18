/**
 * `detectShell` must treat a page inside a Topics browser pane as plain web,
 * even though the Tauri shell injects its IPC globals there as well.
 * @covers TAB-SYNC-01
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { detectShell } from './index';

const g = globalThis as unknown as { window?: Record<string, unknown>; location?: unknown };
const REAL_LOCATION = g.location;

afterEach(() => {
  delete g.window;
  if (REAL_LOCATION === undefined) delete g.location; else g.location = REAL_LOCATION;
});

describe('detectShell', () => {
  test('Tauri IPC globals alone: tauri', () => {
    g.window = { __TAURI_INTERNALS__: {} };
    expect(detectShell()).toBe('tauri');
  });

  test('pane flag together with Tauri IPC globals: web', () => {
    g.window = { __TAURI_INTERNALS__: {}, __TAURI__: {}, __topicsConsoleInstalled: true };
    expect(detectShell()).toBe('web');
  });

  test('pane flag also beats the tauri: origin fallback', () => {
    g.window = { __topicsConsoleInstalled: true };
    g.location = { protocol: 'tauri:', hostname: 'localhost' };
    expect(detectShell()).toBe('web');
  });

  test('tauri: origin without the flag: tauri', () => {
    g.window = {};
    g.location = { protocol: 'tauri:', hostname: 'localhost' };
    expect(detectShell()).toBe('tauri');
  });

  test('no window: web', () => {
    expect(detectShell()).toBe('web');
  });
});
