/**
 * The entrance animation belongs to a message that arrives, not to a row that
 * mounts: history shown again by a tab switch, a split or a remount stays still.
 *
 * @covers TABSWITCH-01
 */
import { describe, expect, test } from 'bun:test';
import { ENTRANCE_WINDOW_MS, MessageEntrance } from './messageEntrance';

describe('MessageEntrance', () => {
  test('the rows of an opening never animate, before or after the list settles', () => {
    const e = new MessageEntrance();
    e.note('t1', ['a', 'b', 'c'], false, 0);
    e.note('t1', ['a', 'b', 'c'], true, 500);
    expect(['a', 'b', 'c'].some((id) => e.isEntering(id, 500))).toBe(false);
  });

  test('a message that comes in after the list settled animates once, then is history', () => {
    const e = new MessageEntrance();
    e.note('t1', ['a'], false, 0);
    e.note('t1', ['a', 'new'], true, 1000);
    expect(e.isEntering('new', 1000)).toBe(true);
    expect(e.isEntering('new', 1000 + ENTRANCE_WINDOW_MS)).toBe(false);
  });

  test('a change of topic is an opening: the old settled flag does not make the new rows arrivals', () => {
    const e = new MessageEntrance();
    e.note('t1', ['a'], true, 0);
    e.note('t2', ['x', 'y'], true, 10);
    expect(e.isEntering('x', 10)).toBe(false);
    e.note('t2', ['x', 'y', 'z'], true, 20);
    expect(e.isEntering('z', 20)).toBe(true);
  });

  test('noting the same ids twice (StrictMode) changes nothing', () => {
    const e = new MessageEntrance();
    e.note('t1', ['a'], false, 0);
    e.note('t1', ['a', 'b'], true, 100);
    e.note('t1', ['a', 'b'], true, 900);
    expect(e.isEntering('b', 1050)).toBe(true);
  });

  test('a row that takes the server id in its place is the same row, not an arrival (card 40ea050c)', () => {
    const e = new MessageEntrance();
    e.note('t1', ['a', 'q'], false, 0);
    e.note('t1', ['a', 'q', 'msg_local'], true, 100);
    expect(e.isEntering('msg_local', 100)).toBe(true);
    // Five seconds later the turn ends and the history reload renames it.
    e.note('t1', ['a', 'q', 'uuid-1'], true, 5100);
    expect(e.isEntering('uuid-1', 5100)).toBe(false);
  });

  test('a rename while the entrance still plays keeps it playing, no restart', () => {
    const e = new MessageEntrance();
    e.note('t1', ['a'], false, 0);
    e.note('t1', ['a', 'msg_local'], true, 100);
    e.note('t1', ['a', 'uuid-1'], true, 400);
    expect(e.isEntering('uuid-1', 400)).toBe(true);
    expect(e.isEntering('uuid-1', 100 + ENTRANCE_WINDOW_MS)).toBe(false);
  });

  test('a new id beside rows that are all still there is an arrival', () => {
    const e = new MessageEntrance();
    e.note('t1', ['a', 'b'], false, 0);
    e.note('t1', ['a', 'b'], true, 10);
    e.note('t1', ['a', 'b', 'c'], true, 2000);
    expect(e.isEntering('c', 2000)).toBe(true);
  });
});
