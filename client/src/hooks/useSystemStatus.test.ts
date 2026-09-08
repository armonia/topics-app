/**
 * The system poll sleeps with the window and refreshes when it returns.
 * Driven through the real hook; only the network, clock and browser events
 * are controlled, so a timer that bypasses visibility fails the request count.
 * @covers SYSTEM-01
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as React from 'react';
import { mount, type Harness } from '../test/reactHarness';
import { useSystemStatus } from './useSystemStatus';

const g = globalThis as unknown as Record<string, unknown>;
const saved: Record<string, unknown> = {};
const savedDoc: Record<string, unknown> = {};
const realDateNow = Date.now;
let clock = 0;
let requests = 0;
let intervals = new Map<number, () => Promise<void>>();
const listeners = new Map<string, Set<() => void>>();
let harness: Harness | null = null;

function on(name: string, fn: () => void): void {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name)!.add(fn);
}
function off(name: string, fn: () => void): void { listeners.get(name)?.delete(fn); }
function visibility(hidden: boolean): void {
  (g.document as { hidden: boolean }).hidden = hidden;
  for (const fn of listeners.get('visibilitychange') ?? []) fn();
}

beforeEach(() => {
  requests = 0;
  clock = 1_700_000_000_000;
  intervals = new Map();
  listeners.clear();
  for (const key of ['fetch', 'document', 'setInterval', 'clearInterval']) saved[key] = g[key];
  const doc = (g.document as Record<string, unknown> | undefined) ?? {};
  for (const key of ['hidden', 'addEventListener', 'removeEventListener']) savedDoc[key] = doc[key];
  doc.hidden = false;
  doc.addEventListener = on;
  doc.removeEventListener = off;
  g.document = doc;
  g.fetch = async () => {
    requests++;
    return new Response(JSON.stringify({ timestamp: String(clock) }));
  };
  let seq = 0;
  g.setInterval = (fn: () => Promise<void>) => { intervals.set(++seq, fn); return seq; };
  g.clearInterval = (id: number) => { intervals.delete(id); };
  Date.now = () => clock;
});

afterEach(() => {
  harness?.unmount();
  harness = null;
  const doc = g.document as Record<string, unknown>;
  for (const [key, value] of Object.entries(savedDoc)) {
    if (value === undefined) delete doc[key]; else doc[key] = value;
  }
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete g[key]; else g[key] = value;
  }
  Date.now = realDateNow;
});

function drive() {
  let state: ReturnType<typeof useSystemStatus> | undefined;
  function Probe(): null {
    const current = useSystemStatus(true, 3000);
    React.useEffect(() => { state = current; });
    return null;
  }
  harness = mount(React.createElement(Probe));
  return { current: () => state! };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function tick(): Promise<void> {
  clock += 4000; // Beyond the shared fetch TTL: a cache hit must not mask a poll.
  for (const fn of intervals.values()) await fn();
}

describe('useSystemStatus visibility', () => {
  test('a hidden window does not read on mount or on its interval', async () => {
    visibility(true);
    drive();
    await settle();
    expect(requests).toBe(0);
    await tick();
    expect(requests).toBe(0);
  });

  test('hiding pauses the poll, returning reads immediately, and unmount removes the timer and listener', async () => {
    const probe = drive();
    await settle();
    expect(requests).toBe(1);
    expect(probe.current().loading).toBe(false);
    visibility(true);
    await tick();
    expect(requests).toBe(1);
    visibility(false);
    await settle();
    expect(requests).toBe(2);
    expect(probe.current().status?.timestamp).toBe(String(clock));
    harness!.unmount();
    expect(intervals.size).toBe(0);
    expect(listeners.get('visibilitychange')?.size).toBe(0);
  });

  test('an explicit refresh still reads while hidden', async () => {
    visibility(true);
    const probe = drive();
    await settle();
    const before = requests;
    clock += 4000;
    await probe.current().refresh();
    expect(requests).toBe(before + 1);
    expect(probe.current().status?.timestamp).toBe(String(clock));
  });
});
