/**
 * THE ERROR STRIP MUST NOT COME BACK FROM THE DEAD ON UN-HIDE.
 *
 * The defect (H7, measured by reading the drain against the Rust queue): the
 * did-fail poll is gated on document visibility, so while the window is hidden
 * `NAV_ERROR_EVENTS` accumulates instead of being drained every second. On
 * un-hide the catch-up read took `events[events.length - 1]` unconditionally,
 * which is how a failure the pane had already navigated away from painted a
 * strip over a page that was loading fine — with a Retry button aimed at the
 * dead URL and a `navFailedAtRef` stamp that kept the progress bar off.
 *
 * The bar: the LIVE poll must keep behaving exactly as before (the queue was
 * drained a second ago, nothing in it can be stale), and the CATCH-UP read must
 * keep only what the pane is still about. `pickNavError(events, undefined)`
 * covers the first, `pickNavError(events, {requested, view})` the second — the
 * pre-fix implementation is `events[events.length - 1]`, and every case below
 * that passes a basis fails against it.
 *
 * @covers BROWSER-01
 */
import { describe, expect, test } from 'bun:test';
import { pickNavError } from './navErrorQueue';

const err = (url: string, description = 'Could not connect to the server.', code = -1004) =>
  ({ url, description, code });

describe('pickNavError — the live poll (no freshness basis)', () => {
  test('takes the newest entry, whatever URL it is about', () => {
    const picked = pickNavError([err('http://a.test/'), err('http://b.test/')]);
    expect(picked?.url).toBe('http://b.test/');
  });

  test('an empty or non-array drain is nothing', () => {
    expect(pickNavError([])).toBeNull();
    expect(pickNavError(null)).toBeNull();
    expect(pickNavError('nope')).toBeNull();
    expect(pickNavError(undefined)).toBeNull();
  });

  test('entries without a url string are skipped, not accepted as blanks', () => {
    const picked = pickNavError([err('http://a.test/'), { description: 'x', code: -1 }]);
    expect(picked?.url).toBe('http://a.test/');
  });

  test('missing description/code degrade to empty/0 instead of undefined in the strip', () => {
    const picked = pickNavError([{ url: 'http://a.test/' }]);
    expect(picked).toEqual({ url: 'http://a.test/', description: '', code: 0 });
  });
});

describe('pickNavError — the catch-up read after a hidden period', () => {
  test('THE DEFECT: an error for a URL the pane has left is dropped', () => {
    // Hidden window: the agent navigated to the bad URL (it failed and queued),
    // then navigated somewhere good. `requested` is the good one because every
    // agent navigation goes through the same `navigate` door as the url bar.
    const picked = pickNavError([err('http://dead.test/')], {
      requested: 'http://good.test/',
      view: 'http://good.test/',
    });
    expect(picked).toBeNull();
  });

  test('a failure the pane is STILL on survives the same read', () => {
    const picked = pickNavError([err('http://dead.test/')], {
      requested: 'http://dead.test/',
      view: 'http://previous.test/',
    });
    expect(picked?.url).toBe('http://dead.test/');
  });

  test('an in-page navigation the client never requested is matched on the view url', () => {
    // Clicking a link inside the page never reaches `navigate`, so `requested`
    // still names the page we asked for; the KVO drain is the only witness.
    const picked = pickNavError([err('http://dead.test/deep')], {
      requested: 'http://good.test/',
      view: 'http://dead.test/deep',
    });
    expect(picked?.url).toBe('http://dead.test/deep');
  });

  test('the newest MATCHING entry wins, not the newest entry', () => {
    const picked = pickNavError(
      [err('http://good.test/', 'first try'), err('http://stale.test/'), err('http://irrelevant.test/')],
      { requested: 'http://good.test/', view: '' },
    );
    expect(picked?.description).toBe('first try');
  });

  test('a trailing slash, a host in caps and a fragment are the same target', () => {
    const picked = pickNavError([err('http://Dead.Test')], {
      requested: 'http://dead.test/#section',
      view: '',
    });
    expect(picked?.url).toBe('http://Dead.Test');
  });

  test('a pane that has never navigated has no basis to judge, so it accepts', () => {
    const picked = pickNavError([err('http://dead.test/')], { requested: '', view: '' });
    expect(picked?.url).toBe('http://dead.test/');
  });

  test('an unparseable failing url still compares as a plain string', () => {
    expect(pickNavError([err('not a url')], { requested: 'not a url', view: '' })?.url).toBe('not a url');
    expect(pickNavError([err('not a url')], { requested: 'http://good.test/', view: '' })).toBeNull();
  });
});
