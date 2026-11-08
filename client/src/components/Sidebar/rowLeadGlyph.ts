/**
 * THE LEADING GLYPH BOX IS DRAWN ONLY WHEN THERE IS A GLYPH TO DRAW.
 *
 * Reported on 03/09 (card 058ea722), with a screenshot: the name of a project
 * row starts far from its accordion, and the air in between is an EMPTY box.
 * It was the 18px slot kept on every project row so that a project without a
 * favicon started its name at the same x as one with a favicon. The owner's
 * rule is the opposite: the name sits at the minimum distance, and it moves
 * right only when there IS an icon to make room for.
 *
 * The chat row had already crossed that line on 29/08 (see the note on
 * `TopicItem.tsx`); this is the same decision for the project row, and for a
 * pinned tile in row form, whose placeholder was the last empty box left.
 *
 * `probing` still holds the place: it is the first encounter with a project,
 * the answer is in flight, and a name that jumps 22px to the left when the
 * probe says "none" is worse than 22px of air for one round trip. From the
 * second render on the store answers from its cache and no box is drawn.
 */
export type ProjectIconStatus = 'probing' | 'has' | 'none';

/** Whether a project row draws, and therefore reserves, its leading glyph box. */
export function projectGlyphSlotShown(status: ProjectIconStatus): boolean {
  return status !== 'none';
}
