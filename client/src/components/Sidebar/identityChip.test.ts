/**
 * The two things about the identity chips that are worth pinning without a
 * browser: the size really is IN the class and it is the row's, not one this
 * band invented, and the groups card stacks a bounded number of marks.
 *
 * The rest (does it fit on one line, is the ink readable over the veil) is a
 * question about pixels and lives in `tests/e2e/identity-chips.spec.ts`: a unit
 * test asserting a class string says nothing about what got painted.
 *
 * @covers STATUSLINE-01
 */
import { describe, expect, test } from 'bun:test';
import { ORG_MARKS_IN_CHIP, chipClass } from './identityChip';

describe('the chip box', () => {

  test('full and empty are the same box: only the fill changes', () => {
    const box = (cls: string) => cls.split(' ').filter((c) => !c.includes('bg-') && !c.includes('border-'));
    expect(box(chipClass(true))).toEqual(box(chipClass(false)));
  });

  test('full carries a resting fill, empty carries none', () => {
    // RESTING, so the `hover:` variants do not count: the empty chip does have
    // a hover fill (it is still a button), and a plain substring match on the
    // colour would have called that a resting fill and passed.
    const resting = (cls: string) => cls.split(' ').filter((c) => /(^|:)bg-/.test(c) && !c.includes('hover:'));
    expect(resting(chipClass(true))).toContain('bg-black/[0.05]');
    expect(resting(chipClass(false))).toEqual([]);
    // The empty one is not invisible: it is an outline, and a dashed one, which
    // is what says "slot" instead of "card that failed to load".
    expect(chipClass(false)).toContain('border-dashed');
  });

  test('hover is felt ON TOP of the resting veil, not equal to it', () => {
    // A chip already carrying 0.05 with a `hover:bg-black/[0.05]` is a chip
    // that stops answering the pointer. This is the regression that made the
    // sidebar hover token unusable here.
    expect(chipClass(true)).toContain('hover:bg-black/[0.10]');
    expect(chipClass(true)).not.toContain('hover:bg-black/[0.05]');
  });
});

describe('the marks inside the one group card', () => {
  test('two, which is where overlapped discs stop being told apart', () => {
    // Not a taste and not a layout accident: past two, the marks are
    // twelve-pixel circles each as wide as the digit that would count them.
    // The card carries the count from there on, and the panel carries the
    // names.
    expect(ORG_MARKS_IN_CHIP).toBe(2);
  });
});
