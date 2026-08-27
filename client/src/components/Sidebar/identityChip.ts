/**
 * THE SHAPE OF AN IDENTITY CHIP, in one place and measurable.
 *
 * The three subjects at the foot of the column (me, the groups, the people)
 * used to be immersed chips: no border, no fill, the lift only on hover. That
 * reads as three pieces of text with some padding around them, and it costs
 * two things that are not decoration.
 *
 * ONE: THE TARGET. A chip that is only its text is 18px tall and, when it is a
 * lone glyph, 22px wide. Both are under the 24px floor a pointer target is
 * supposed to hold, and the smallest of the three was the one you press to
 * find out where your people are.
 *
 * TWO: THE EMPTY ONES ARE UNREADABLE. The question the band exists to answer
 * is "what am I part of", and the answer has to include the NOs. With no fill
 * and no border, a subject with nothing in it is indistinguishable from the
 * gap between two subjects: the group chip did not even render at zero, so
 * "which groups am I in" answered "none of your business" to the only person
 * who needed the answer. Here the empty state is a chip that is still THERE,
 * drawn as an outline instead of a filled card: the slot is visible, its being
 * empty is visible, and it stays a door.
 *
 * That is the whole idea: FULL is a filled mini-card, EMPTY is the same box in
 * outline. One glance counts how many of the three are filled.
 *
 * WHY THESE ALPHAS. The band sits on the sidebar chrome (`--chrome-bg`:
 * #eaecf0 light, #080a0e dark), which is not a content surface, so the veil is
 * written in alpha over whatever the chrome is rather than as a hex that would
 * be right on one theme only. The numbers hold two constraints at once:
 *
 *  · the fill has to SEPARATE from the chrome (>= 1.1:1, the same
 *    perceptibility floor `SIDEBAR_HOVER` was tuned against): 0.05/0.07 give
 *    1.12:1 light and 1.20:1 dark;
 *  · the fill must not EAT the text on top of it. A veil is a background
 *    change, and the ink tokens on this chrome were measured against the bare
 *    chrome. Black at 5% over a light chrome only darkens it, so dark ink gains
 *    contrast; white at 7% over the dark chrome lifts it, which is the
 *    direction that LOSES, so dark mode is the case the e2e measures for real
 *    (`identity-chips.spec.ts`) instead of trusting this comment.
 *
 * And hover still has to be felt ON TOP of the resting veil: reusing
 * `SIDEBAR_HOVER` here would have landed on a chip that already carries that
 * exact value, i.e. a chip that stops answering the pointer. The hover steps
 * are the resting ones plus roughly the same delta again.
 */

/**
 * The floor for anything you point at, in CSS px, on BOTH sides. Not a
 * rounded-up 44: this band lives in the chrome next to 24px controls, and a
 * target sized for a thumb would push the foot of the column into the tree.
 * It is the number the e2e measures on every chip.
 */
export const CHIP_TARGET_PX = 24;

/** The box every chip is, full or empty: same height, same radius, same
 *  padding, so the difference between them is the FILL and nothing else. */
// The 24 is WRITTEN OUT here and not interpolated from `CHIP_TARGET_PX`:
// Tailwind finds classes by scanning the source text, so `min-h-[${n}px]`
// generates no rule at all and the floor would silently be whatever the text
// happened to measure. The unit test is what keeps the two in step.
const CHIP_BOX =
  'flex min-h-[24px] min-w-[24px] items-center gap-1 ' +
  'rounded-md border px-1.5 py-0.5 transition-colors';

/** FULL: a filled mini-card with a border that exists at rest. */
const CHIP_FULL =
  'border-black/[0.08] bg-black/[0.05] hover:bg-black/[0.10] ' +
  'dark:border-white/[0.11] dark:bg-white/[0.07] dark:hover:bg-white/[0.13]';

/** EMPTY: the same box in outline. Dashed, because a solid empty outline reads
 *  as a card that failed to load rather than as a slot waiting to be filled. */
const CHIP_EMPTY =
  'border-dashed border-black/[0.16] hover:bg-black/[0.05] ' +
  'dark:border-white/[0.18] dark:hover:bg-white/[0.08]';

/**
 * The class of a chip, given whether its subject HAS anything in it.
 *
 * `filled` is not "the data arrived", it is "there is something to look at":
 * a group you belong to, a person who is around, an account that is yours.
 */
export function chipClass(filled: boolean): string {
  return `${CHIP_BOX} ${filled ? CHIP_FULL : CHIP_EMPTY}`;
}

/**
 * How many group chips stay on the line before the rest collapse into one
 * counter.
 *
 * The groups used to WRAP: the subject took as many lines as it needed, which
 * was fine while the band was a wrapping flow and is impossible now that the
 * three subjects share one row. Two is not a taste: at the narrowest sidebar
 * the row has to fit the name of whoever is logged in (which truncates, but
 * not to nothing), two group marks and the people chip, and the third group
 * mark is the one that starts pushing the name below its own ellipsis.
 */
export const ORGS_INLINE = 2;

/** The groups that stay on the line, and how many are left over. The overflow
 *  is not hidden: it becomes a `+n` chip that opens the full list, which is
 *  the difference between "collapsed" and "lost". */
export function splitOrgs<T>(orgs: readonly T[], max = ORGS_INLINE): { inline: T[]; extra: number } {
  if (orgs.length <= max) return { inline: [...orgs], extra: 0 };
  // One slot goes to the `+n` chip itself, otherwise showing `max` marks plus a
  // counter makes the subject WIDER than the cap it is supposed to enforce.
  const keep = Math.max(0, max - 1);
  return { inline: orgs.slice(0, keep), extra: orgs.length - keep };
}

/**
 * THE DIM INK OF A CHIP, and why it is not `--text-muted`.
 *
 * The secondary things in the band (the people count, the word "friends", the
 * inventory signal, an empty glyph) want ink that recedes, and the token for
 * that is `--text-muted`. Measured on the real pixels, it does not survive the
 * veil above: in LIGHT the chip is a black wash over the chrome, which pulls
 * the background DOWN toward the dark ink instead of away from it, so muted
 * text drops from 4.50:1 on the bare chrome to 4.07:1 on a chip.
 *
 * That is worth writing down because it is the opposite of the intuition this
 * file was built on. "A dark veil under dark ink only helps" is true of the
 * INK and false of the RATIO: contrast is a distance, and moving the ground
 * toward the figure shortens it whichever way it moves. `--text-muted` in
 * light is tuned to land exactly on 4.50:1 over `--chrome-bg`, so it has no
 * margin left to spend and ANY veil breaks it.
 *
 * So the band's dim ink is the secondary token, one step darker, which keeps
 * the hierarchy (it still recedes against `--text-app-text`) and measures
 * 5.06:1 light and 7.90:1 dark over the veil. The e2e reads it off the
 * composited pixels, not off this comment.
 */
export const CHIP_INK_DIM = 'text-app-text-secondary';
