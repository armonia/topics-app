/**
 * The room a closed fold keeps below the last row (`useDisclosureAnchor`).
 *
 * @covers CHAT-FOLD-01
 */
import { describe, expect, it } from 'bun:test';
import { slackAfter } from './useDisclosureAnchor';

// The room a closed fold leaves below the last row: kept while the view needs
// it to stay where it is, given back as soon as it is out of sight.
describe('slackAfter', () => {
  it('no room kept: nothing to give back', () => {
    expect(slackAfter(0, 500, 800, 2000)).toBe(0);
  });

  it('at the bottom with 120 px of room, all of it is still in view', () => {
    // content 2000 - 120 = 1880; the view ends at 1200 + 800 = 2000.
    expect(slackAfter(120, 1200, 800, 2000)).toBe(120);
  });

  it('a reader 50 px up from that bottom needs 50 px less', () => {
    expect(slackAfter(120, 1150, 800, 2000)).toBe(70);
  });

  it('new output that fills the room makes it unnecessary', () => {
    // 200 px of rows arrived: the content alone reaches past the view.
    expect(slackAfter(120, 1200, 800, 2200)).toBe(0);
  });

  it('never grows: room is added by a hold only', () => {
    expect(slackAfter(40, 1300, 800, 2000)).toBe(40);
  });
});
