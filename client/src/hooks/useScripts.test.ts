/**
 * The shared scripts store: an unchanged answer publishes nothing, and the
 * poll stays relaxed while ANY consumer still holds the WS channel.
 *
 * Both were measured in the app: after a few tab switches the poll ran every
 * 3.0 s instead of 15 s (the first project window to unmount cleared a global
 * `wsConnected` for everybody), and each poll re-rendered every mounted
 * project sidebar and its file tree with an identical list.
 *
 * @covers PROCESS-01
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { __scriptsStoreForTests as store } from './useScripts';
import type { ScriptProcessInfo } from '../lib/api';

const REAL_FETCH = globalThis.fetch;
let answer: ScriptProcessInfo[];
let fetches: number;
const cleanups: Array<() => void> = [];

const script = (over: Partial<ScriptProcessInfo> = {}): ScriptProcessInfo => ({
  processId: 'p1',
  scriptName: 'dev',
  command: 'bun run dev',
  projectPath: '/p',
  status: 'running',
  pid: 42,
  startedAt: '2026-09-30T10:00:00.000Z',
  ports: [5173],
  ...over,
});

beforeEach(() => {
  answer = [script()];
  fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    // A fresh array and fresh objects on every answer, like the real JSON.
    return new Response(JSON.stringify({ scripts: answer }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  globalThis.fetch = REAL_FETCH;
});

/**
 * One fetch that has fully landed. `fetchScripts` returns at once while another
 * is in flight (the first subscriber starts one), so the queue is drained
 * before and after.
 */
async function poll(): Promise<void> {
  const drain = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
  await drain();
  await store.fetchScripts();
  await drain();
}

/** Subscribe a counting listener; unsubscribed in afterEach. */
function listen(): { readonly calls: number } {
  let calls = 0;
  const unsub = store.subscribe(() => { calls++; });
  cleanups.push(unsub);
  return { get calls() { return calls; } };
}

describe('publishing', () => {
  test('an identical poll answer keeps the snapshot and notifies nobody', async () => {
    const l = listen();
    await poll();
    const first = store.getSnapshot();
    const callsAfterFirst = l.calls;

    await poll();
    await poll();

    expect(fetches).toBeGreaterThanOrEqual(3);
    expect(store.getSnapshot()).toBe(first);
    expect(l.calls).toBe(callsAfterFirst);
  });

  test('a change in ANY rendered field publishes: watchers, exitCode, completedAt, ports', async () => {
    const l = listen();
    await poll();
    const variants: Partial<ScriptProcessInfo>[] = [
      { watchers: [{ label: 'agent', since: '2026-09-30T10:01:00.000Z' }] },
      { status: 'done', exitCode: 0, completedAt: '2026-09-30T10:02:00.000Z' },
      { status: 'done', exitCode: 1, completedAt: '2026-09-30T10:02:00.000Z' },
      { ports: [5173, 5174] },
    ];
    for (const v of variants) {
      const before = store.getSnapshot();
      const calls = l.calls;
      answer = [script(v)];
      await poll();
      expect(store.getSnapshot()).not.toBe(before);
      expect(l.calls).toBe(calls + 1);
    }
  });

  test('a WS push equal to what is shown publishes nothing either', async () => {
    const l = listen();
    await poll();
    const shown = store.getSnapshot();
    const calls = l.calls;
    store.handleWSUpdate(JSON.parse(JSON.stringify(shown)));
    expect(store.getSnapshot()).toBe(shown);
    expect(l.calls).toBe(calls);
  });
});

describe('poll interval', () => {
  test('one consumer leaving the WS channel does not drop the others to the 3 s poll', () => {
    listen();
    store.markVisible(true);
    cleanups.push(() => store.markVisible(false));
    // Two project sidebars hold the channel.
    store.setWSConnected(true);
    store.setWSConnected(true);
    expect(store.pollIntervalMs()).toBe(15_000);

    // One unmounts: the other is still connected.
    store.setWSConnected(false);
    expect(store.pollIntervalMs()).toBe(15_000);

    // The last one leaves: now nobody gets pushes, and the poll tightens.
    store.setWSConnected(false);
    expect(store.pollIntervalMs()).toBe(3_000);
  });
});
