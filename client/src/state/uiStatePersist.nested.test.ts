/**
 * A client nested in a Topics browser pane is a read-only mirror: the per-record
 * browser keys (task-browser-tabs, topic-browser) must never be PUT from there,
 * or the real app would open the same tabs through the server's WS fan-out.
 * @covers BROWSER-STATE-01
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createUiStatePersister } from './uiStatePersist';
import { __resetNestedPaneForTests } from '../lib/shell/nestedPane';

const g = globalThis as unknown as { window?: Record<string, unknown>; fetch: unknown };
const REAL_FETCH = g.fetch;
const REAL_WINDOW = g.window;
let calls: string[];

function setNested(nested: boolean): void {
  g.window = nested ? { __topicsConsoleInstalled: true } : {};
  (g.window as Record<string, unknown>).self = g.window;
  (g.window as Record<string, unknown>).top = g.window;
  __resetNestedPaneForTests();
}

beforeEach(() => {
  calls = [];
  g.fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    return new Response(JSON.stringify({ server_seq: 1 }), { status: 200 });
  };
});
afterEach(() => {
  g.fetch = REAL_FETCH;
  if (REAL_WINDOW === undefined) delete g.window; else g.window = REAL_WINDOW;
  __resetNestedPaneForTests();
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

describe('uiStatePersist inside a Topics pane', () => {
  test('control: outside a pane a put reaches the server', async () => {
    setNested(false);
    const writes = createUiStatePersister();
    writes.put('topic-browser:mirror', { a: 1 }, 0);
    await tick();
    expect(calls).toEqual(['PUT /api/ui-state/topic-browser:mirror']);
  });

  test('nested: put and flushAll send nothing, and no flight is left counted', async () => {
    setNested(true);
    const held: unknown[] = [];
    const writes = createUiStatePersister({ onDeferredFrame: (_k, v) => { held.push(v); } });
    writes.put('topic-browser:mirror', { a: 1 }, 0);
    writes.put('task-browser-tabs:t1', { b: 2 }, 50);
    writes.flushAll();
    await tick();
    expect(calls).toEqual([]);
    // A frame is applied at once: nothing is "in flight" to hold it back.
    expect(writes.admitFrame('topic-browser:mirror', { theirs: true }, 3)).toBe('apply');
  });
});
