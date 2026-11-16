/**
 * Is this error the database saying "another connection holds the lock, and
 * it kept holding it past `busy_timeout`"?
 *
 * bun:sqlite throws a `SQLiteError` with `code: "SQLITE_BUSY"` and errno 5
 * (measured on Bun 1.3.8, two handles on one WAL file, one inside
 * `BEGIN IMMEDIATE`). The extended codes (`SQLITE_BUSY_SNAPSHOT`,
 * `SQLITE_BUSY_RECOVERY`) share the prefix. SQLITE_LOCKED (errno 6, a lock
 * held inside the same connection, `busy_timeout` does not wait on it) counts
 * too, with its extended codes: it is just as transient, and the backfill of
 * `tool-output-store.ts` already treated the two alike. The message is matched
 * as well, for an error re-wrapped on its way here that kept only its text.
 *
 * It is a TRANSIENT refusal: the same statement succeeds once the holder lets
 * go, so a caller that can wait (a deferred write, a backfill tick) waits and
 * tries again. It is never a reason to take the process down, and it is also
 * not a licence to swallow it everywhere: a caller that cannot try again later
 * has to report it, which is why this is a predicate and not a handler.
 */
export function isSqliteBusy(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code ?? "";
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(`${String(code)} ${String(err)}`);
}

/** Waits between tries of a write the database refused as busy: about 18 minutes in all. */
export const BUSY_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000, ...Array<number>(16).fill(60_000)];

export interface WriteWhenFreeOptions {
  /** Override of `BUSY_RETRY_DELAYS_MS`, for the tests. */
  delaysMs?: readonly number[];
  /** Where the notices go. Defaults to `console.warn`. */
  warn?: (message: string, err: unknown) => void;
}

/**
 * Runs `write` now and, if the database refuses it as busy, again later.
 *
 * For the writes nobody waits on: a timer, an interval or a promise nobody
 * awaits. There a thrown SQLITE_BUSY reaches the uncaught-exception net of
 * `server.ts` (which rethrows it and the server exits 7) or becomes an
 * unhandled rejection (exit 1), and the write it carried is lost with the
 * process. Here it becomes a warning and a retry on an unref'd timer.
 *
 * Returns what `write` returned when it went through now, `undefined` when it
 * was deferred. `write` must be safe to run again: a refused statement wrote
 * nothing (a transaction rolls back whole), but a write made of several
 * statements outside a transaction has to be idempotent.
 *
 * Any other error is rethrown untouched, on the first try to the caller, on a
 * retry from its timer: the same as a write that was never wrapped.
 */
export function writeWhenFree<T>(label: string, write: () => T, opts: WriteWhenFreeOptions = {}): T | undefined {
  const delays = opts.delaysMs ?? BUSY_RETRY_DELAYS_MS;
  const warn = opts.warn ?? ((message: string, err: unknown) => console.warn(message, err));
  const attempt = (tries: number): T | undefined => {
    try {
      return write();
    } catch (err) {
      if (!isSqliteBusy(err)) throw err;
      const delay = delays[tries];
      if (delay === undefined) {
        warn(`[sqlite-busy] ${label}: database still busy after ${tries + 1} tries, write given up`, err);
        return undefined;
      }
      warn(`[sqlite-busy] ${label}: database busy, write retried in ${delay} ms (try ${tries + 1})`, err);
      const timer = setTimeout(() => { attempt(tries + 1); }, delay);
      // An owed write never keeps the process alive on its own.
      (timer as { unref?: () => void }).unref?.();
      return undefined;
    }
  };
  return attempt(0);
}

/**
 * The `.catch` for a promise nobody awaits: a busy refusal becomes a warning,
 * anything else is rethrown, so it stays the unhandled rejection it was.
 */
export function warnIfBusy(label: string, warn: (message: string, err: unknown) => void = (m, e) => console.warn(m, e)): (err: unknown) => void {
  return (err) => {
    if (!isSqliteBusy(err)) throw err;
    warn(`[sqlite-busy] ${label}: database busy, this pass skipped`, err);
  };
}
