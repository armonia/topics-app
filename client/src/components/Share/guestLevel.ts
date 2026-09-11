/**
 * THE GUEST SCALE, and the one question anybody asks of it.
 *
 * It lives beside `GuestCard` rather than inside it because a component file
 * that also exports a plain function loses Fast Refresh for the whole module -
 * `react-refresh/only-export-components`, and the rule is right: a saved edit
 * would remount the guest view instead of patching it.
 *
 * The scale is the client's half of the server's `meetsLevel`
 * (`server/lib/grants-query.ts`), and it must stay the same shape: "at least
 * X", never an `if` per level written by hand at each call site. Two ladders
 * with the same names and different order is how a surface starts offering a
 * button the server refuses.
 */

/** `deny` is not a rung: it blocks, and never reaches a surface that ranks. */
export type GuestLevel = 'read' | 'comment' | 'edit';

const RANK: Record<GuestLevel, number> = { read: 0, comment: 1, edit: 2 };

/** The same question `meetsLevel` asks on the server, asked the same way. */
export function guestMeets(level: GuestLevel, min: GuestLevel): boolean {
  return RANK[level] >= RANK[min];
}
