/**
 * A stable key for a composer attachment (a `File`, a pasted image): the same
 * object keeps its chip. Keyed by position, removing the first chip handed its
 * node to the next one, which changed shape in that frame (core:F13).
 */
const keys = new WeakMap<object, number>();
let nextKey = 0;

export function attachmentKey(item: object): number {
  let k = keys.get(item);
  if (k === undefined) { k = ++nextKey; keys.set(item, k); }
  return k;
}
