/**
 * The order a palette's results keep while the query stays the same.
 *
 * Topics are ranked by recency, and a chat moves to the top every time it
 * changes: a turn that ends anywhere, a rename. With the palette open that
 * reordered the rows under the reader and under Enter (row 0 became another
 * chat), and on Chromium (WebView2 on Windows) the move threw a list scrolled
 * by finger back to the top. Raycast and Linear keep the rows where they are
 * until the query changes; so does this.
 *
 * Rows already ranked keep their rank; rows the ranking has not seen (a chat
 * created while the palette is open) follow, in their fresh order.
 */
export function keepOrder<T extends { id: string }>(
  fresh: readonly T[],
  rank: ReadonlyMap<string, number> | null,
): T[] {
  if (!rank) return fresh.slice();
  const known: T[] = [];
  const unseen: T[] = [];
  for (const item of fresh) (rank.has(item.id) ? known : unseen).push(item);
  known.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  return [...known, ...unseen];
}

/** The rank of each row of `ordered`, for the next `keepOrder`. */
export function rankOf(ordered: readonly { id: string }[]): Map<string, number> {
  return new Map(ordered.map((item, i) => [item.id, i]));
}
