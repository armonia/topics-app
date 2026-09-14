/**
 * @covers TOPIC-BROWSER-01
 * ONE EDGE, ONE FUNCTION.
 *
 * The window's left edge and the chat's right padding land on the same
 * column because both come from here. They used to be two formulas, one in
 * JS and one in CSS: on a 900px window they disagreed by 96px and the window
 * sat on the composer. Below a usable area it now cedes nothing at all: a
 * 2px window hides its own way out.
 */
import { describe, test, expect } from 'bun:test';
import { expandedInsetFor, canExpandInArea, MIN_CHAT_WIDTH, MIN_EXPANDABLE_AREA, DEFAULT_EXPANDED_WIDTH } from './topicBrowserWindowLazy';

describe('the space the chat cedes when the window is expanded', () => {
  test('a wide area gives the window exactly what it asked for', () => {
    expect(expandedInsetFor(1440, DEFAULT_EXPANDED_WIDTH)).toBe(DEFAULT_EXPANDED_WIDTH);
  });

  test('a narrow area cuts the window, never the chat below its minimum', () => {
    // 740 px of area: this is the case that used to cover the composer.
    expect(expandedInsetFor(740, 480)).toBe(740 - MIN_CHAT_WIDTH);
    expect(740 - expandedInsetFor(740, 480)).toBe(MIN_CHAT_WIDTH);
  });

  test('an area narrower than the chat minimum cedes nothing at all', () => {
    expect(expandedInsetFor(240, 480)).toBe(0);
  });

  test('an area too narrow for both cedes nothing: the window stays afloat', () => {
    // A split project at 1024 leaves about 322px: the docked window came
    // out 2px wide and its own minimize button could not be clicked.
    expect(expandedInsetFor(322, 480)).toBe(0);
    expect(canExpandInArea(322)).toBe(false);
  });

  test('the floor is exact: one pixel decides', () => {
    expect(canExpandInArea(MIN_EXPANDABLE_AREA - 1)).toBe(false);
    expect(canExpandInArea(MIN_EXPANDABLE_AREA)).toBe(true);
  });

});
