/**
 * Detection of "this client is nested inside a Topics browser pane".
 * The answer must be true for the Tauri pane flag and for any iframe, and
 * false for the main window, the web app and the landing demo.
 * @covers TAB-SYNC-01
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { isNestedInTopicsPane, __resetNestedPaneForTests } from './nestedPane';

type FakeWindow = Record<string, unknown>;
const g = globalThis as unknown as { window?: FakeWindow };

function installWindow(extra: FakeWindow = {}): FakeWindow {
  const w: FakeWindow = { ...extra };
  w.self = w;
  w.top = w;
  g.window = w;
  return w;
}

beforeEach(() => { __resetNestedPaneForTests(); });
afterEach(() => { delete g.window; __resetNestedPaneForTests(); });

describe('isNestedInTopicsPane', () => {
  test('no window (SSR, tests): not nested', () => {
    delete g.window;
    expect(isNestedInTopicsPane()).toBe(false);
  });

  test('the main window (no pane flag, top === self): not nested', () => {
    installWindow();
    expect(isNestedInTopicsPane()).toBe(false);
  });

  test('the Tauri pane flag marks it nested', () => {
    installWindow({ __topicsConsoleInstalled: true });
    expect(isNestedInTopicsPane()).toBe(true);
  });

  test('an iframe (top !== self) is nested', () => {
    const w = installWindow();
    w.top = {};
    expect(isNestedInTopicsPane()).toBe(true);
  });

  test('a cross-origin top that throws on read counts as an iframe', () => {
    const w = installWindow();
    Object.defineProperty(w, 'top', { get() { throw new Error('SecurityError'); } });
    expect(isNestedInTopicsPane()).toBe(true);
  });

  test('the landing demo is never nested, even inside its iframe', () => {
    const w = installWindow({ __topicsDemo: true });
    w.top = {};
    expect(isNestedInTopicsPane()).toBe(false);
  });

  test('the answer is computed once: a flag raised later does not flip it', () => {
    const w = installWindow();
    expect(isNestedInTopicsPane()).toBe(false);
    w.__topicsConsoleInstalled = true;
    expect(isNestedInTopicsPane()).toBe(false);
  });
});
