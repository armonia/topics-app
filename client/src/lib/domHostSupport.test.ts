import { describe, expect, test } from 'bun:test';
import { autoFollowsViewers, domHostAccepted, noteDomHostAccepted, subscribeDomHostAccepted } from './domHostSupport';

/** @covers NATIVE-HOST-03 */

describe('the Mac stays native while another device watches', () => {
  test("'auto' follows the viewer count until the server relays mirrors, then stays native", () => {
    expect(autoFollowsViewers(true, 'auto', false)).toBe(true);
    expect(autoFollowsViewers(true, 'auto', true)).toBe(false);
    // Pinned modes and the web never followed it.
    expect(autoFollowsViewers(true, 'shared', false)).toBe(false);
    expect(autoFollowsViewers(false, 'auto', false)).toBe(false);
  });

  test('the first ack reaches every pane once, and the answer sticks', () => {
    let heard = 0;
    const stop = subscribeDomHostAccepted(() => { heard += 1; });
    expect(domHostAccepted()).toBe(false);
    noteDomHostAccepted();
    noteDomHostAccepted();
    expect(domHostAccepted()).toBe(true);
    expect(heard).toBe(1);
    stop();
  });
});
