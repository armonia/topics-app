/**
 * @covers USAGE-20
 *
 * The banner that says the plan's usage window is spent has to go away ON ITS
 * OWN when the published reset arrives. Nothing announces that moment: the
 * server sends a frame when the hold starts and one when it is lifted, never
 * one for the deadline merely passing. So the store has to notice by itself,
 * and it is that self-expiry these tests hold in place.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import {
  _adoptForTests,
  _readForTests,
  _resetForTests,
  _subscribeForTests,
} from './providerHold';

/** A `provider:hold` frame as the socket delivers it. */
function holdFrame(untilMs: number | null): unknown {
  return { type: 'provider:hold', untilMs, window: 'five_hour', sinceMs: Date.now() };
}

const settle = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

afterEach(() => {
  _resetForTests();
});

describe('USAGE-20: the plan-limit banner expires by itself', () => {
  it('drops the hold when the deadline passes, with no frame arriving', async () => {
    _adoptForTests(holdFrame(Date.now() + 40));
    expect(_readForTests(), 'the hold is in force before its deadline').not.toBeNull();

    await settle(90);

    // Nobody sent anything: the only thing that happened is that time passed.
    expect(_readForTests(), 'past its deadline the hold reads as absent').toBeNull();
  });

  it('tells its listeners when it expires, so the banner can leave the screen', async () => {
    let announcements = 0;
    const stop = _subscribeForTests(() => {
      announcements += 1;
    });
    try {
      _adoptForTests(holdFrame(Date.now() + 40));
      const onArrival = announcements;

      await settle(90);

      // The read being pure is only half of it: without an announcement the
      // component never re-renders and the banner stays up on stale state.
      expect(announcements, 'the expiry is announced, not just recorded').toBeGreaterThan(onArrival);
    } finally {
      stop();
    }
  });

  it('adopts a hold that is already past its deadline as nothing at all', () => {
    _adoptForTests(holdFrame(Date.now() - 1000));
    expect(_readForTests(), 'an expired hold never becomes the current one').toBeNull();
  });

  it('lifts the hold on a frame that carries no deadline', () => {
    _adoptForTests(holdFrame(Date.now() + 60_000));
    expect(_readForTests()).not.toBeNull();

    _adoptForTests(holdFrame(null));

    expect(_readForTests(), 'a null deadline is the server lifting the hold').toBeNull();
  });

  it('keeps a hold whose deadline is still ahead', () => {
    _adoptForTests(holdFrame(Date.now() + 60_000));

    const hold = _readForTests();
    expect(hold?.window).toBe('five_hour');
  });
});
