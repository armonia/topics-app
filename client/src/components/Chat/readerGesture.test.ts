/**
 * The reader's own scrolls, told apart from the list's (CHAT-HIST-01): an input
 * opens a window, a press holds it, and a scroll that keeps going (momentum)
 * stays the reader's after the window.
 * @covers CHAT-HIST-01
 */
import { describe, expect, test } from 'bun:test';
import { GESTURE_WINDOW_MS, SCROLL_CHAIN_MS, readerGesture } from './readerGesture';

describe('readerGesture', () => {
  test('a scroll with no input before it is not the reader\'s', () => {
    const g = readerGesture();
    expect(g.scrolled(1_000)).toBe(false);
  });

  test('an input makes the scrolls of its window the reader\'s, and no later one', () => {
    const g = readerGesture();
    g.input(1_000);
    expect(g.scrolled(1_000 + GESTURE_WINDOW_MS - 1)).toBe(true);
    expect(g.scrolled(1_000 + GESTURE_WINDOW_MS + SCROLL_CHAIN_MS + 1)).toBe(false);
  });

  test('a press held past the window keeps the drag the reader\'s until it is released', () => {
    const g = readerGesture();
    g.press(0);
    // A scrollbar dragged slowly: scroll events far apart, long after the press.
    expect(g.scrolled(1_500)).toBe(true);
    expect(g.scrolled(3_000)).toBe(true);
    g.release(3_100);
    expect(g.scrolled(3_100 + GESTURE_WINDOW_MS - 1)).toBe(true);
    expect(g.scrolled(3_100 + GESTURE_WINDOW_MS + SCROLL_CHAIN_MS + 1)).toBe(false);
  });

  test('a flick\'s momentum stays the reader\'s for as long as its events keep coming', () => {
    const g = readerGesture();
    g.input(0);
    let t = 0;
    for (; t < 2_000; t += 16) expect(g.scrolled(t)).toBe(true);
    // The list stops, then moves on its own: not the reader.
    expect(g.scrolled(t + SCROLL_CHAIN_MS + 1)).toBe(false);
  });

  test('a move of the list right after the window, with no reader\'s scroll before it, is not chained', () => {
    const g = readerGesture();
    g.input(0);
    expect(g.scrolled(GESTURE_WINDOW_MS + 10)).toBe(false);
    expect(g.scrolled(GESTURE_WINDOW_MS + 20)).toBe(false);
  });

  test('a release with no press does not open a window', () => {
    const g = readerGesture();
    g.release(1_000);
    expect(g.scrolled(1_001)).toBe(false);
  });
});
