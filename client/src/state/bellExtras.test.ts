/**
 * The bell's shared lists: the hub's counters that arrive while a read is
 * going are read right after it. Dropped, the closed bell said 217 where the
 * open panel listed 231 (22/11, on the live hub).
 *
 * @covers NOTIF-ONE-02
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { clearBellExtras, refreshBellExtras } from './bellExtras';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; clearBellExtras(); });

function fakeHub(): { asked: string[]; release: () => void } {
  const asked: string[] = [];
  let open: () => void = () => {};
  const gate = new Promise<void>((r) => { open = r; });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url.replace(/^.*\/api\/hub\//, ''));
    // The first round hangs until released: the next counters arrive meanwhile.
    if (asked.length <= 2) await gate;
    const body = url.includes('/automations')
      ? { needsYou: [{ key: 'cron:a', provider: 'jarvis', title: 'A', reason: 'stuck' }], broken: [{ key: 'cron:b', title: 'B' }] }
      : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { asked, release: open };
}

describe('bellExtras', () => {
  test('counters that arrive during a read are read right after it, not dropped', async () => {
    const hub = fakeHub();
    // The hub answers but its automations topic has not arrived yet: no counters.
    const first = refreshBellExtras(null);
    // Its first frame lands while that read is still going.
    void refreshBellExtras('1:1');
    hub.release();
    await first;
    // The queued read runs on its own: wait until it asked for the automations.
    for (let i = 0; i < 50 && !hub.asked.includes('automations'); i++) await new Promise((r) => setTimeout(r, 5));
    expect(hub.asked.filter((p) => p === 'automations')).toHaveLength(1);
  });

  test('the same counters again do not read the megabyte twice', async () => {
    const hub = fakeHub();
    hub.release();
    await refreshBellExtras('1:1');
    await refreshBellExtras('1:1');
    expect(hub.asked.filter((p) => p === 'automations')).toHaveLength(1);
  });
});
