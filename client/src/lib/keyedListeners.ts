/**
 * A registry of listeners grouped by key: `subscribe` returns the unsubscribe,
 * and the last unsubscribe of a key drops its Set so idle keys do not pile up.
 * `emit` walks a snapshot, so a listener may unsubscribe (or subscribe another)
 * while it runs without changing who is called in this round.
 */
export interface KeyedListeners<K, F extends (...args: never[]) => void> {
  subscribe(key: K, fn: F): () => void;
  emit(key: K, ...args: Parameters<F>): void;
  /** Listeners currently registered for `key`. */
  size(key: K): number;
  /** Forget every listener of every key. */
  clear(): void;
}

export function createKeyedListeners<K, F extends (...args: never[]) => void = () => void>(): KeyedListeners<K, F> {
  const byKey = new Map<K, Set<F>>();
  return {
    subscribe(key, fn) {
      let set = byKey.get(key);
      if (!set) {
        set = new Set();
        byKey.set(key, set);
      }
      set.add(fn);
      return () => {
        const cur = byKey.get(key);
        if (!cur) return;
        cur.delete(fn);
        if (cur.size === 0) byKey.delete(key);
      };
    },
    emit(key, ...args) {
      const set = byKey.get(key);
      if (set) for (const fn of [...set]) fn(...args);
    },
    size: (key) => byKey.get(key)?.size ?? 0,
    clear: () => byKey.clear(),
  };
}
