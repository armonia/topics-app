/**
 * @covers CHROME-10
 *
 * THE QUESTION IS ASKED AGAIN, EVERY TIME (board card c0faad1d).
 *
 * `fetchBootDegraded` used to keep the first "yes" forever, on the belief that
 * the shell's verdict is written once and never unset. It is not: the shell
 * publishes the marker path before the search starts and RETRACTS it on the
 * branch where deleting the marker would change nothing (a live daemon pid,
 * `lib.rs` `WaitForKnownServer`). With the cache, the bar kept offering "delete
 * the marker and reopen" for the whole session and the button answered "not
 * degraded".
 *
 * The shell comes in as an argument rather than through `mock.module`, which is
 * process-wide and followed this file into the rest of the shard.
 */
import { describe, expect, test } from 'bun:test';
import { fetchBootDegraded } from './bootDegraded';

describe('asking the shell twice', () => {
  test('the second question reaches the shell, and its answer wins', async () => {
    const markerPath = '/x/external-server-seen';
    const answers: unknown[] = [
      { degraded: true, markerPath, port: 3333 },
      { degraded: false, markerPath: null, port: 3333 },
    ];
    let calls = 0;
    const shell = () => Promise.resolve(answers[Math.min(calls++, answers.length - 1)]);

    expect((await fetchBootDegraded(shell))?.markerPath).toBe(markerPath);
    // Red the moment the yes is cached again: the call never leaves and the
    // retraction is invisible to the surface.
    expect(await fetchBootDegraded(shell)).toBeNull();
    expect(calls).toBe(2);
  });

  test('a shell that throws is a silence, not a crash', async () => {
    expect(await fetchBootDegraded(() => Promise.reject(new Error('no such command')))).toBeNull();
  });
});
