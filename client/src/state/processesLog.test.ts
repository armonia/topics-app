/**
 * The palette's «Log»: the request opens Processes and is answered once, in
 * its window.
 *
 * @covers HUBBR-19
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { openProcessesLog, takeProcessesLogRequest } from './processesLog';

// In bun there is no window: a fake one records the events the request fires.
const fired: string[] = [];
(globalThis as { window?: unknown }).window = {
  dispatchEvent: (e: { type: string; init?: { detail?: { type?: string } } }) => {
    fired.push(e.init?.detail?.type ? `${e.type}:${e.init.detail.type}` : e.type);
    return true;
  },
};
const hadCustomEvent = 'CustomEvent' in globalThis;
const hadEvent = 'Event' in globalThis;
class FakeEvent { constructor(readonly type: string, readonly init?: unknown) {} }
(globalThis as { CustomEvent?: unknown }).CustomEvent ??= FakeEvent;
(globalThis as { Event?: unknown }).Event ??= FakeEvent;

// The fake window would flip `typeof window` for the later files in a shard.
afterAll(() => {
  delete (globalThis as { window?: unknown }).window;
  if (!hadCustomEvent) delete (globalThis as { CustomEvent?: unknown }).CustomEvent;
  if (!hadEvent) delete (globalThis as { Event?: unknown }).Event;
});

describe('processesLog', () => {
  test('opens Processes, and a fresh request is taken once, a stale one never', () => {
    openProcessesLog(1_000);
    expect(fired[0]).toMatch(/^topics:open-utility/);
    expect(fired).toContain('topics:processes-log');
    expect(takeProcessesLogRequest(2_000)).toBe(true);
    expect(takeProcessesLogRequest(2_000)).toBe(false);
    openProcessesLog(1_000);
    expect(takeProcessesLogRequest(1_000 + 60_000)).toBe(false);
  });
});
