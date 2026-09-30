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
});
