/**
 * Reads started ahead of their caller, adopted once by the caller that asks
 * for the same key shortly after.
 *
 * The case it exists for: the palette's Enter starts the first-page history
 * read of the chat it is about to open (`chatApi.warmHistory`), and the chat
 * pane's own `getHistory`, issued a render later, adopts the request already
 * in flight instead of sending a second one. Short-lived on purpose: a read is
 * only worth adopting across that gap.
 */
const WARM_READ_TTL_MS = 2_000;
const warm = new Map<string, { at: number; promise: Promise<unknown> }>();

/** Start `read` now under `key`, unless a fresh one is already in flight. */
export function warmRead<T>(key: string, read: () => Promise<T>): void {
  const held = warm.get(key);
  if (held && Date.now() - held.at < WARM_READ_TTL_MS) return;
  const promise = read();
  // Nobody may ever adopt it: its failure must not surface as unhandled.
  promise.catch(() => {});
  warm.set(key, { at: Date.now(), promise });
  setTimeout(() => {
    if (warm.get(key)?.promise === promise) warm.delete(key);
  }, WARM_READ_TTL_MS);
}

/**
 * The answer of the warm read under `key`, consumed (a key is adopted once), or
 * null when there is none, it is stale, or it failed: then the caller reads.
 */
export async function adoptWarmRead<T>(key: string): Promise<T | null> {
  const held = warm.get(key);
  if (!held) return null;
  warm.delete(key);
  if (Date.now() - held.at >= WARM_READ_TTL_MS) return null;
  return (await held.promise.catch(() => null)) as T | null;
}
