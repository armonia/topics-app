/**
 * The detail slider: a press picks the nearest stop or steps from an end glyph,
 * a drag follows the pointer and rests on the end once past it.
 *
 * @covers KANBAN-108
 */
import { describe, expect, test } from 'bun:test';
import { densityStopForDrag, densityStopForPress } from './densityStops';

describe('densityStopForPress', () => {
  test('on the track: the nearest of the three stops', () => {
    expect(densityStopForPress(0, 2, 2)).toBe(0);
    expect(densityStopForPress(0.24, 0, 2)).toBe(0);
    expect(densityStopForPress(0.26, 0, 2)).toBe(1);
    expect(densityStopForPress(1, 0, 2)).toBe(2);
  });
  test('on an end glyph: one step that way, clamped', () => {
    expect(densityStopForPress(-0.3, 2, 2)).toBe(1);
    expect(densityStopForPress(-0.3, 0, 2)).toBe(0);
    expect(densityStopForPress(1.3, 1, 2)).toBe(2);
    expect(densityStopForPress(1.3, 2, 2)).toBe(2);
  });
});

describe('densityStopForDrag', () => {
  test('follows the pointer along the track', () => {
    expect(densityStopForDrag(0.1, 2)).toBe(0);
    expect(densityStopForDrag(0.5, 2)).toBe(1);
    expect(densityStopForDrag(0.9, 2)).toBe(2);
  });
  test('past an end it rests there instead of stepping again', () => {
    expect(densityStopForDrag(-5, 2)).toBe(0);
    expect(densityStopForDrag(7, 2)).toBe(2);
  });
});
