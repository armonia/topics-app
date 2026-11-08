/**
 * makeSerialQueue — serializes async work per key.
 *
 * Design invariant (task e33820da):
 * The promise stored in the map (`tail`) must NEVER reject without a handler.
 * Under Bun an unhandled rejection terminates the process, so a failing `fn`
 * killed the server if the map held a rejecting promise.
 *
 * Pattern:
 *   const tail = next.catch(() => undefined);   // swallow into map-tail
 *   void tail.then(() => { ... });               // GC, non-throwing
 *   queues.set(key, tail);
 *   return next;                                 // caller gets the real outcome
 *
 * `next` can still reject (the caller decides what to do with it); `tail` —
 * the promise kept in the map — never does.
 */
export function makeSerialQueue(): {
  enqueue<T>(key: string, fn: () => Promise<T>): Promise<T>;
  size(): number;
} {
  const queues = new Map<string, Promise<unknown>>();

  function enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = queues.get(key) ?? Promise.resolve();
    // `next` reflects the real outcome of `fn`: it resolves with fn's value or
    // rejects with fn's error. The caller gets this so it can handle failures.
    const next = prev.catch(() => undefined).then(fn);

    // `tail` is a swallowed copy stored in the map. It never rejects, so Bun
    // cannot see an unhandled rejection from us.
    const tail = next.catch(() => undefined);
    queues.set(key, tail);

    // GC: remove the entry once the tail settles — but only if nothing newer
    // has overwritten our slot. `.finally()` was the original choice but it
    // returns a NEW promise that also rejects when `next` rejects: same bug,
    // different spelling. A plain `.then()` on the already-swallowed `tail`
    // is safe.
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });

    return next;
  }

  return { enqueue, size: () => queues.size };
}
