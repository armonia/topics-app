/**
 * ONE CHIP PER PERSON WHO IS HERE, and nothing else.
 *
 * The foot of the column used to answer three questions with three chips: me,
 * my groups, my people. The two collective ones said their subject as a COUNT
 * ("2 of 7 online", two overlapped faces and a `+n`), which is the shape of an
 * answer you have to open a panel to actually use: a number cannot be greeted,
 * cannot be clicked, and says the same word whether the person behind it is
 * the one you are waiting for or a stranger who shares a group with you.
 *
 * So the count becomes PEOPLE: one chip per person who is around right now,
 * with their face and their name, and the row scrolls sideways when there are
 * more of them than the column is wide. A chip is a door to that person; a
 * count was a door to a list of doors.
 *
 * AND ONLY WHO IS AROUND. Everybody you know is not a thing to draw at the
 * bottom of a column - it is an address book, it lives behind the profile menu
 * with the rest of the account. What earns permanent room on screen is the
 * part that CHANGES during the day, which is who turned up.
 *
 * THE ROW DISAPPEARS WHEN IT IS EMPTY, which is the opposite of the rule the
 * three old chips followed (they stayed at zero so their place could be
 * learned). Those chips were the only way in; this row is not - the same
 * people, present or not, are one click away in the profile menu - so a strip
 * of permanent nothing at the foot of the column would be reserving space to
 * say "nobody", every day, to whoever works alone.
 */
import type { PresenceRow } from './orgPresence';

/** A person to draw on the band: who they are, and what to draw them with. */
export interface FriendChip {
  id: string;
  /** The name as it goes on the chip: first name only (see `firstName`). */
  name: string;
  /** The whole name, for the tooltip and the accessible name: the chip is
   *  short by design, and shortening must not make a person unnameable. */
  fullName: string;
  avatarUrl: string | null;
  initials: string;
}

/**
 * The first name, which is what a chip has room for.
 *
 * A sidebar is 240px wide and a chip on a scrolling row competes with its
 * neighbours: "Alexandra Kowalczyk" truncates to "Alexandra K…" at best, and
 * the surname is the half that never survives anyway. The whole name stays on
 * the chip's `title` and on its accessible name, so nothing is lost, it is
 * just not shouted.
 */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? '';
}

/**
 * The chips, from the rows the band already computes.
 *
 * ONLY WHO IS PRESENT: absence is not a chip, it is the reason the person is
 * not on the row. Order comes in already decided by `friendRows` (present
 * first, then most recently seen, then the name), so this function does not
 * re-sort: two orderings of the same people is how a face jumps places between
 * the row and the panel that opens under it.
 *
 * DEDUPLICATED BY ID, because the same person can arrive twice when the rows
 * are merged from more than one source (the friendship graph and an
 * organisation's member list name the same human), and two chips for one
 * person is a band whose count you stop trusting.
 */
export function friendChips(rows: readonly PresenceRow[]): FriendChip[] {
  const seen = new Set<string>();
  const chips: FriendChip[] = [];
  for (const row of rows) {
    if (!row.presente || seen.has(row.id)) continue;
    seen.add(row.id);
    chips.push({
      id: row.id,
      name: firstName(row.nome),
      fullName: row.nome,
      avatarUrl: row.avatarUrl,
      initials: row.iniziali,
    });
  }
  return chips;
}
