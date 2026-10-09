import type { CoalescedMessage } from './coalesceToolRun';

/**
 * How many items were PREPENDED between two renders of the transcript.
 *
 * Virtuoso keeps the viewport still across a prepend only if it is told how
 * many items went in above the first one: `firstItemIndex` must decrease by
 * exactly that number (`MessageList`). The list does not carry that number -
 * it is a fresh array - so it is read off the two arrays: the item that WAS
 * first is looked up in the new list, and its new position is the count.
 *
 * The lookup goes through the carriers: a tool run coalesced into one item may
 * grow BACKWARDS when the older page arrives (the work-only messages before
 * its head join the same run), and the old head's id then lives inside the new
 * carrier's `mergedIds`. `carrierById` of the new list maps it there.
 *
 * Zero for anything that is not a prepend: an append (first item unchanged),
 * a list replaced wholesale (old first item gone), an empty side. Constant in
 * the common case - a streaming frame appends and the first item is the same
 * object - so this can run on every render.
 */
export function countItemsAddedAbove(
  prev: readonly CoalescedMessage[],
  next: readonly CoalescedMessage[],
  carrierById: ReadonlyMap<string, string>,
): number {
  if (prev.length === 0 || next.length === 0) return 0;
  const first = prev[0];
  if (first === next[0] || (first.id && first.id === next[0].id)) return 0;
  if (!first.id) return 0;
  const target = carrierById.get(first.id) ?? first.id;
  const now = next.findIndex((item) => item.id === target);
  return now > 0 ? now : 0;
}
