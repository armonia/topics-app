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
import { ROW_H } from '../../lib/selectionStyles';

/**
 * THE CHIPS ARE AS BIG AS THE TABS ABOVE THEM.
 *
 * They used to have a floor of their own, 24px, argued from the pointer target
 * and from "the band lives in the chrome, next to 24px controls". Both halves
 * were true and the conclusion was still wrong, because it made the foot of
 * the column the only place in the sidebar with a size nothing else shares:
 * a pinned tile right above is {@link ROW_H}, 34 with the mouse and 44 with the
 * finger, and the three chips underneath were ten pixels shorter than the row
 * they hang from. Ten pixels is not a taste, it is the difference between a
 * band that reads as the last row of the column and a band that reads as a
 * strip somebody glued under it.
 *
 * So the chips take the ROW family, the same constant the tiles take. The
 * pointer floor is not lost in the move, it is exceeded: 34 is ten past the 24
 * this file used to defend, and 44 with the finger is the iOS minimum exactly.
 *
 * The 34 is therefore no longer written here at all. It arrives as a class
 * string from `selectionStyles`, which is where Tailwind already scans it.
 */
export const CHIP_TARGET_PX = 34;

/** The box every chip is, full or empty: same height, same radius, same
 *  padding, so the difference between them is the FILL and nothing else.
 *  The radius follows the height: `rounded-md` on a 24px pill is the same
 *  curvature `rounded-lg` gives a 34px tile, and the tiles are what this band
 *  now has to agree with. */
// `min-w-[34px]` is WRITTEN OUT and not interpolated from `CHIP_TARGET_PX`:
// Tailwind finds classes by scanning the source text, so `min-w-[${n}px]`
// generates no rule at all and the floor would silently be whatever the text
// happened to measure. The unit test is what keeps the two in step.
const CHIP_BOX =
  `flex ${ROW_H} min-w-[34px] items-center gap-1 ` +
  'rounded-lg border px-2 py-0.5 transition-colors';

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
 * THE GROUPS ARE ONE SLOT, and this is where the counting used to happen.
 *
 * There was a cap (two marks on the line) and a `splitOrgs` that decided which
 * groups stayed and which collapsed into a `+n` chip beside them. It was an
 * honest answer to "the line is finite" and it produced a subject whose WIDTH
 * depended on how many groups you had joined that week: one chip, two chips,
 * two chips and a counter. A place whose shape changes with the data is a
 * place you re-read instead of glancing at, which is the very defect the band
 * was rebuilt to remove, and it survived inside one of its three subjects.
 *
 * Now the groups are ONE card, always, whatever the count: the marks stack
 * inside it and the number rides along. Nothing is hidden that was visible
 * before, because the `+n` chip was never showing the groups either, it was
 * showing their number and a door. The door is now the card itself.
 *
 * How many marks stack inside that one card before the count carries the rest.
 * Two, and for the same reason two of anything fits here: past that they are
 * twelve-pixel discs nobody can tell apart, each as wide as the digit that
 * would count them.
 */
export const ORG_MARKS_IN_CHIP = 2;

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
