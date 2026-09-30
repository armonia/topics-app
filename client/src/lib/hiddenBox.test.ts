/**
 * A hidden pane's 0x0 box is not a measure: the chat list keeps its geometry
 * across a tab switch.
 *
 * @covers PERF-01
 */
import { describe, expect, test } from 'bun:test';
import { hasNoBox } from './hiddenBox';

describe('hasNoBox', () => {
  test('a display:none element reports 0x0: no box', () => {
    expect(hasNoBox({ width: 0, height: 0 })).toBe(true);
  });
  test('an empty element in the layout keeps its width: it has a box', () => {
    expect(hasNoBox({ width: 640, height: 0 })).toBe(false);
  });
  test('a real measure is a box', () => {
    expect(hasNoBox({ width: 640, height: 107 })).toBe(false);
  });
});
