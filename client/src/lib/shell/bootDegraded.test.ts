/**
 * @covers CHROME-10
 *
 * The shell's boot verdict, as the SPA reads it.
 *
 * The rule this pins down is the ASYMMETRY. The explanation ("this machine has
 * already run a server on :3333, so Topics waits for that one; delete this file to
 * get a local one") must appear ONLY when the shell says so. During an ordinary
 * outage — a server restart, a cold start, a browser tab with no shell at all — the
 * same sentence would send whoever reads it to delete a file that has nothing to do
 * with the wait. So anything that is not an explicit `degraded: true` with a path
 * parses to null: an old shell, a malformed payload, a missing field.
 *
 * Measured on Windows 2.2.199 on 2026-08-28 (board card d1f702ab): with the marker
 * present and no server, the app said "Reconnecting" forever and named nothing.
 */
import { describe, test, expect } from 'bun:test';
import { degradedNotice, parseBootDegraded, watchBootDegraded } from './bootDegraded';

describe('boot verdict from the shell', () => {
  test('the degraded answer carries the cause and the way out', () => {
    const path = 'C:\\Users\\x\\AppData\\Roaming\\io.armonia.topics.tauri\\external-server-seen';
    expect(parseBootDegraded({ degraded: true, markerPath: path, port: 3333 })).toEqual({
      markerPath: path,
      port: 3333,
    });
  });

  test('an ordinary outage explains nothing', () => {
    expect(parseBootDegraded({ degraded: false, markerPath: null, port: 3333 })).toBeNull();
  });

  test('degraded without a path is not an explanation: naming no file is no way out', () => {
    expect(parseBootDegraded({ degraded: true, markerPath: '', port: 3333 })).toBeNull();
    expect(parseBootDegraded({ degraded: true, port: 3333 })).toBeNull();
  });

  test('a shell too old to answer stays silent', () => {
    expect(parseBootDegraded(undefined)).toBeNull();
    expect(parseBootDegraded(null)).toBeNull();
    expect(parseBootDegraded('boom')).toBeNull();
  });

  test('a missing port falls back instead of printing a hole in the sentence', () => {
    const v = parseBootDegraded({ degraded: true, markerPath: '/tmp/seen' });
    expect(v?.port).toBe(3333);
  });
});

describe('what the offline surface prints', () => {
  const shell = { markerPath: '/Users/x/Library/Application Support/io.armonia.topics.tauri/external-server-seen', port: 3333 };

  test('marker present and nothing connected: the cause and the file are named', () => {
    for (const s of ['offline', 'reconnecting', 'connecting', undefined]) {
      const n = degradedNotice(shell, s);
      expect(n?.markerPath).toBe(shell.markerPath);
      expect(n?.port).toBe('3333');
      expect(n?.whyKey).toBe('statusBar.degraded.why');
      expect(n?.wayOutKey).toBe('statusBar.degraded.wayOut');
    }
  });

  test('a live connection has nothing to explain', () => {
    expect(degradedNotice(shell, 'connected')).toBeNull();
  });

  test('no verdict from the shell, no sentence', () => {
    expect(degradedNotice(null, 'offline')).toBeNull();
  });
});

describe('a "no" may just be early, so it is not remembered', () => {
  // Measured on the Windows machine on 2026-08-28, stopwatch on the shell's own
  // stderr: the window paints at ~+5s, the boot verdict lands at ~+150s. The
  // probe loop is 60 rounds of two connections with a gap, which on that machine
  // takes minutes, not the "~42s" its message claims. A question asked once at
  // mount is therefore asked ~145s before there is an answer — and caching that
  // "no" meant the explanation could never appear at all. Photographed twice on
  // the hardware: verdict reached, marker set, and the bar still said only
  // "Offline".
  test('the payload of a boot that has not decided yet parses to null', () => {
    // This is the answer the shell gives for the first ~150s: not degraded YET.
    expect(parseBootDegraded({ degraded: false, markerPath: null, port: 3333 })).toBeNull();
  });

  test('and the same shell later answers degraded, with the path', () => {
    const late = parseBootDegraded({ degraded: true, markerPath: '/x/external-server-seen', port: 3333 });
    expect(late?.markerPath).toBe('/x/external-server-seen');
  });
});

describe('a "yes" is not remembered either: the shell takes it back', () => {
  // THE BUG THIS PINS DOWN (board card c0faad1d). The shell publishes the
  // marker's path BEFORE the search, then retracts it on the branch where
  // deleting the marker would change nothing (a live daemon pid on the port,
  // `WaitForKnownServer`). The client cached the first yes and stopped asking,
  // so the bar offered "delete the marker and reopen" for the rest of the
  // session and the button answered "not degraded".
  const marker = { markerPath: '/x/external-server-seen', port: 3333 };

  /** Every report the surface received, in order. */
  function collect(answers: (typeof marker | null)[]) {
    const seen: (typeof marker | null)[] = [];
    let n = 0;
    return new Promise<(typeof marker | null)[]>((resolve) => {
      const stop = watchBootDegraded(
        (d) => {
          seen.push(d);
          if (seen.length === answers.length) {
            stop();
            resolve(seen);
          }
        },
        1,
        () => Promise.resolve(answers[Math.min(n++, answers.length - 1)]),
      );
    });
  }

  test('the retraction reaches the surface: yes, then no, is a no', async () => {
    expect(await collect([marker, null])).toEqual([marker, null]);
  });

  test('so the sentence and its button stop being drawn', async () => {
    const [first, second] = await collect([marker, null]);
    expect(degradedNotice(first, 'offline')).not.toBeNull();
    expect(degradedNotice(second, 'offline')).toBeNull();
  });

  test('and a late yes still arrives, which is why the asking never stops', async () => {
    expect(await collect([null, null, marker])).toEqual([null, null, marker]);
  });
});
