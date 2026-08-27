/**
 * Tests for the pending-navigation channel of the task browser tabs, and for
 * the rule that decides when a request is needed at all (`applyTaskTabOpen`).
 * @covers BROWSER-STATE-01
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  requestTaskTabNavigate,
  clearTaskTabNavigate,
  getTaskTabNavigates,
  subscribeTaskTabNavigate,
  __resetTaskTabNavigate,
} from './taskTabNavigate';
import { applyTaskTabOpen, getTaskTabs, forgetTaskTabs, __resetTaskTabs } from './taskBrowserTabs';

const TASK = '77aabb01-0e15-4aa0-ab25-f00000000000';
const CTX = 'task-77aabb01-a1234567';

const REAL_FETCH = globalThis.fetch;

beforeEach(() => {
  __resetTaskTabNavigate();
  __resetTaskTabs();
  // The store persists through ui-state; nothing here is about the network.
  globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  forgetTaskTabs(TASK);
  __resetTaskTabNavigate();
});

describe('taskTabNavigate', () => {
  test('request → readable, notified; clear → gone, notified', () => {
    let n = 0;
    const unsub = subscribeTaskTabNavigate(() => { n++; });
    requestTaskTabNavigate(CTX, 'https://a.test/');
    expect(getTaskTabNavigates()[CTX]).toBe('https://a.test/');
    expect(n).toBe(1);
    clearTaskTabNavigate(CTX);
    expect(getTaskTabNavigates()[CTX]).toBeUndefined();
    expect(n).toBe(2);
    unsub();
  });

  test('the landing URL of a redirect wins over the one announced first', () => {
    requestTaskTabNavigate(CTX, 'https://a.test/');
    requestTaskTabNavigate(CTX, 'https://a.test/landed');
    expect(getTaskTabNavigates()[CTX]).toBe('https://a.test/landed');
  });

  test('the same URL twice, and empty inputs, notify nobody', () => {
    requestTaskTabNavigate(CTX, 'https://a.test/');
    let n = 0;
    const unsub = subscribeTaskTabNavigate(() => { n++; });
    requestTaskTabNavigate(CTX, 'https://a.test/');
    requestTaskTabNavigate(CTX, '');
    requestTaskTabNavigate('', 'https://a.test/');
    clearTaskTabNavigate('task-unknown-0');
    unsub();
    expect(n).toBe(0);
  });
});

describe('applyTaskTabOpen', () => {
  test('a NEW tab is recorded without a navigation request (it mounts on initialUrl)', () => {
    applyTaskTabOpen(TASK, CTX, 'https://a.test/', 'App', 'agent');
    expect(getTaskTabs(TASK).tabs.map((t) => t.url)).toEqual(['https://a.test/']);
    expect(getTaskTabNavigates()[CTX]).toBeUndefined();
  });

  test('re-opening an EXISTING tab elsewhere asks it to navigate', () => {
    applyTaskTabOpen(TASK, CTX, 'https://a.test/', 'App', 'agent');
    applyTaskTabOpen(TASK, CTX, 'https://b.test/', 'App', 'agent');
    expect(getTaskTabs(TASK).tabs.map((t) => t.url)).toEqual(['https://b.test/']);
    expect(getTaskTabNavigates()[CTX]).toBe('https://b.test/');
  });

  test('a second tab of the same task gets its own channel, untouched by the first', () => {
    const other = 'task-77aabb01-b7654321';
    applyTaskTabOpen(TASK, CTX, 'https://a.test/', 'App', 'agent');
    applyTaskTabOpen(TASK, other, 'https://r.test/', 'Report', 'agent');
    applyTaskTabOpen(TASK, CTX, 'https://a.test/2', 'App', 'agent');
    expect(getTaskTabNavigates()[CTX]).toBe('https://a.test/2');
    expect(getTaskTabNavigates()[other]).toBeUndefined();
  });
});
