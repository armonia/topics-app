import { describe, expect, it } from 'bun:test';
import { drainTerminalSessions } from './drain-terminals';

/** @covers E2E-GATE-12 */
describe('drainTerminalSessions', () => {
  const noSleep = async () => {};

  it('returns nothing once the sessions are gone, and stops asking', async () => {
    let rounds = 0;
    const left = await drainTerminalSessions(
      async () => (rounds >= 3 ? [] : ['a', 'b']),
      async () => { rounds++; },
      5_000,
      noSleep,
    );
    expect(left).toEqual([]);
    expect(rounds).toBe(3);
  });

  it('gives up on the budget and hands back who is still there', async () => {
    // The clock is injected: the test must not pay the wait it is proving.
    let t = 0;
    const left = await drainTerminalSessions(
      async () => ['stuck-1'],
      async () => {},
      1_000,
      noSleep,
      () => (t += 400),
    );
    expect(left).toEqual(['stuck-1']);
  });

  it('still fires one round on a zero budget', async () => {
    // The behaviour that was there before the wait existed: never LESS than the
    // second DELETE the guard has always sent.
    let kills = 0;
    const left = await drainTerminalSessions(
      async () => ['x'],
      async () => { kills++; },
      0,
      noSleep,
    );
    expect(kills).toBe(1);
    expect(left).toEqual(['x']);
  });

  it('a session that clears on the first round costs one round trip, not a wait', async () => {
    let slept = 0;
    const left = await drainTerminalSessions(
      async () => [],
      async () => {},
      5_000,
      async () => { slept++; },
    );
    expect(left).toEqual([]);
    expect(slept).toBe(0);
  });
});
