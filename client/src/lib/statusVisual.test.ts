/**
 * The status vocabulary: one colour per meaning, rose never among them.
 *
 * @covers STATUS-VISUAL-01
 */
import { describe, expect, test } from 'bun:test';
import { STATUS_CHIP, STATUS_DOT, STATUS_ICON, STATUS_INK } from './statusVisual';
import { DANGER_TEXT, WARNING_TEXT } from './popoverStyles';

describe('statusVisual', () => {
  test('identical pairs come from one place', () => {
    expect(STATUS_INK.wait).toBe(WARNING_TEXT);
    expect(STATUS_INK.danger).toBe(DANGER_TEXT);
  });

  test('working is sky and never the green of done', () => {
    expect(STATUS_INK.working).toContain('sky');
    expect(STATUS_DOT.working).toContain('sky');
    expect(STATUS_INK.working).not.toBe(STATUS_INK.ok);
  });

  test('no status uses rose', () => {
    for (const group of [STATUS_INK, STATUS_DOT, STATUS_CHIP]) {
      for (const cls of Object.values(group)) expect(cls).not.toContain('rose');
    }
  });

  test('every meaning has a distinct glyph', () => {
    const icons = Object.values(STATUS_ICON);
    expect(new Set(icons).size).toBe(icons.length);
  });
});
