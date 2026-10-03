/**
 * TAB IN A FORM STEPS THROUGH EVERY CONTROL AND NEVER LEAVES IT.
 *
 * @covers USERMENU-06
 */
import { describe, expect, test } from 'bun:test';
import { stepFocus } from './stepFocus';

const items = ['field', 'save', 'copy'] as const;

describe('stepFocus', () => {
  test('one forward, one back, from the middle', () => {
    expect(stepFocus(items, 'save', false)).toBe('copy');
    expect(stepFocus(items, 'save', true)).toBe('field');
  });

  test('wraps at the two ends', () => {
    expect(stepFocus(items, 'copy', false)).toBe('field');
    expect(stepFocus(items, 'field', true)).toBe('copy');
  });

  test('from outside the list it enters on the first, or the last going back', () => {
    expect(stepFocus(items, null, false)).toBe('field');
    expect(stepFocus(items, null, true)).toBe('copy');
  });
});
