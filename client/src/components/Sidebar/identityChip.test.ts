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
import { CHIP_TARGET_PX, ORG_MARKS_IN_CHIP, SUBJECT_FLOOR, chipClass } from './identityChip';
import { ROW_H } from '../../lib/selectionStyles';

describe('the chip box', () => {
  // THE HEIGHT COMES FROM THE ROW FAMILY, the one the pinned tiles above the
  // band use. This is the test that fails when somebody gives the band a
  // measure of its own again, which is how it drifted ten pixels under the
  // tiles the first time.
  test('a chip is as tall as a row, on both pointer families', () => {
    for (const filled of [true, false]) {
      expect(chipClass(filled)).toContain(ROW_H);
    }
    // The mouse half of that constant is the number the e2e measures, so the
    // two have to be the same 34 and not two numbers that happen to agree.
    expect(ROW_H).toContain(`${CHIP_TARGET_PX}px`);
  });

  // Tailwind reads the SOURCE, so the width floor is a literal in the class
  // string and the constant is a second copy of it. Same drift, same net.
  test('the width floor is in the class', () => {
    for (const filled of [true, false]) {
      expect(chipClass(filled)).toContain(`min-w-[${CHIP_TARGET_PX}px]`);
    }
  });

  // THE SUBJECT AROUND THE CHIP HAS THE SAME FLOOR. When these two numbers
  // disagree the flex item is allowed to become narrower than the chip it
  // holds, and the chip paints the difference over the next subject: the band
  // still measures as one line with no overflow, so nothing catches it except
  // this and the box assertions in the e2e.
  test('a subject may not shrink below the chip it contains', () => {
    expect(SUBJECT_FLOOR).toBe(`min-w-[${CHIP_TARGET_PX}px]`);
    expect(chipClass(true)).toContain(SUBJECT_FLOOR);
  });

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
