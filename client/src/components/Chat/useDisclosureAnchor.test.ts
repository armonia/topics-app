/**
 * The room a closed fold keeps below the last row, and how far a hold moves the
 * view in a frame (`useDisclosureAnchor`).
 *
 * @covers CHAT-FOLD-01
 */
import { describe, expect, it } from 'bun:test';
import { holdShift, slackAfter } from './useDisclosureAnchor';

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

// How far a hold moves the view in one frame: back to the anchor's place, or,
// for a fold at the end toggled from the bottom, to the bottom.
describe('holdShift', () => {
  it('a fold anywhere: the view moves by what the anchor moved', () => {
    expect(holdShift(null, 400, 430, 0)).toBe(30);
    expect(holdShift(null, 400, 380, 0)).toBe(-20);
  });

  it('a log opening under a reader at the bottom: the view follows the end by the log', () => {
    // The row is 400 px down the view and the log took 300 px under it.
    expect(holdShift(0, 400, 400, 300)).toBe(300);
  });

  it('a log taller than the room above its row: the end comes up until the row reaches the top, no further', () => {
    expect(holdShift(0, 120, 120, 300)).toBe(120);
    // The next frame, the row at the top: nothing left to move.
    expect(holdShift(0, 120, 0, 180)).toBe(0);
  });

  it('a log closing under a reader at the bottom: the clamp already put the view at the end', () => {
    expect(holdShift(0, 100, 400, 0)).toBe(0);
    expect(holdShift(3, 100, 400, 0)).toBe(-3);
  });

  it('a row already above the view: the end does not take it further away', () => {
    expect(holdShift(0, -10, -10, 300)).toBe(0);
  });
});
