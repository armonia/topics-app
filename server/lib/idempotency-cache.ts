/**
 * Bounded, TTL'd idempotency cache for retryable POSTs.
 *
 * Extracted verbatim from server/routes/terminal.ts (the create-session route),
 * where it dedups POST /api/terminal/sessions retries: the client sends an
 * X-Idempotency-Key (paneId:closedAt) on reopen, so a transient 5xx on the HEAD
 * probe doesn't spawn duplicate PTY sessions when the client retries the POST.
 *
 * Semantics preserved exactly:
 *   - lookup() lazily evicts an expired entry and returns null for it.
 *   - remember() stamps `now + ttlMs` and, only when the map grows past maxSize,
 *     opportunistically sweeps expired entries (no dedicated timer).
 *
 * `now` is injectable purely so the unit test can drive TTL expiry without real
 * time; production calls default to Date.now.
 */
export interface IdempotencyCache {
  /** Return the remembered value for `key`, or null if absent/expired. */
  lookup(key: string): string | null;
  /** Remember `value` under `key` for the cache's TTL. */
  remember(key: string, value: string): void;
  /** Current entry count (including not-yet-swept expired entries). For tests/diagnostics. */
  size(): number;
}

export interface IdempotencyCacheOptions {
  /** Entry lifetime in ms. Default 60_000 (covers any realistic retry). */
  ttlMs?: number;
  /** Sweep expired entries once the map grows past this. Default 128. */
  maxSize?: number;
  /** Clock injection seam for deterministic tests. Default Date.now. */
  now?: () => number;
}

export function createIdempotencyCache(opts: IdempotencyCacheOptions = {}): IdempotencyCache {
  const ttlMs = opts.ttlMs ?? 60_000;
  const maxSize = opts.maxSize ?? 128;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { value: string; expiresAt: number }>();

  return {
    lookup(key) {
      const entry = cache.get(key);
      if (!entry) return null;
      if (entry.expiresAt < now()) {
        cache.delete(key);
        return null;
      }
      return entry.value;
    },
    remember(key, value) {
      cache.set(key, { value, expiresAt: now() + ttlMs });
      // Opportunistic sweep — keeps the map bounded without a dedicated timer.
      if (cache.size > maxSize) {
        const t = now();
        for (const [k, v] of cache) {
          if (v.expiresAt < t) cache.delete(k);
        }
      }
    },
    size() {
      return cache.size;
    },
  };
}
