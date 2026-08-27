/**
 * The two things about the identity chips that are worth pinning without a
 * browser: the target floor really is IN the class, and the overflow of the
 * groups never makes the subject wider than the cap.
 *
 * The rest (does it fit on one line, is the ink readable over the veil) is a
 * question about pixels and lives in `tests/e2e/identity-chips.spec.ts`: a unit
 * test asserting a class string says nothing about what got painted.
 *
 * @covers STATUSLINE-01
 */
import { describe, expect, test } from 'bun:test';
import { CHIP_TARGET_PX, ORGS_INLINE, chipClass, splitOrgs } from './identityChip';

describe('the chip box', () => {
  // Tailwind reads the SOURCE, so the 24 is a literal in the class string and
  // the constant is a second copy of it. This is the test that fails when
  // somebody moves one without the other, which is the only way they can drift.
  test('the target floor is in the class, on both sides', () => {
    for (const filled of [true, false]) {
      const cls = chipClass(filled);
      expect(cls).toContain(`min-h-[${CHIP_TARGET_PX}px]`);
      expect(cls).toContain(`min-w-[${CHIP_TARGET_PX}px]`);
    }
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

describe('the groups that do not fit', () => {
  const orgs = (n: number) => Array.from({ length: n }, (_, i) => `org${i}`);

  test('under the cap they all stay, with no counter', () => {
    expect(splitOrgs(orgs(1))).toEqual({ inline: ['org0'], extra: 0 });
    expect(splitOrgs(orgs(ORGS_INLINE))).toEqual({ inline: orgs(ORGS_INLINE), extra: 0 });
  });

  test('over the cap, the counter takes a slot instead of being added to them', () => {
    // Three groups with a cap of two is the case that used to widen the row:
    // two marks PLUS a `+1` is three things in two slots.
    const { inline, extra } = splitOrgs(orgs(3));
    expect(inline.length + 1).toBeLessThanOrEqual(ORGS_INLINE);
    expect(extra).toBe(2);
  });

  test('the overflow counts what is not on the line, so nothing is lost', () => {
    const { inline, extra } = splitOrgs(orgs(9));
    expect(inline.length + extra).toBe(9);
  });

  test('no groups at all is not an error: an empty split, and the caller draws the empty chip', () => {
    expect(splitOrgs(orgs(0))).toEqual({ inline: [], extra: 0 });
  });
});
