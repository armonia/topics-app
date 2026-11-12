/**
 * The client side of the machine-wide heavy-command queue (see
 * `server/services/heavy-slot.ts`). Plain `fetch`, no dependency, so a shell
 * hook can reach it through `bun scripts/heavy-slot.ts`.
 *
 * IT FAILS OPEN, ALWAYS. Topics off, a refused connection, a timeout, an odd
 * answer: the caller gets `null` and runs its command at once. The wait is
 * bounded too (`maxWaitMs`): past it the command runs anyway, because a queue
 * that can hold a gate forever turns its own bug into a turn that never ends.
 */

export interface HeavyLease {
  id: string;
  waitedMs: number;
  /** Frees the place and stops the renewal. Idempotent, never throws. */
  release: () => Promise<void>;
}

export interface AcquireOptions {
  base: string;
  label: string;
  pid: number;
  maxWaitMs: number;
  fetchFn?: typeof fetch;
  now?: () => number;
  onWait?: (message: string) => void;
  /** Renewal cadence while the command runs; 0 disables (tests). */
  renewEveryMs?: number;
}

async function post(fetchFn: typeof fetch, url: string, body: unknown, timeoutMs: number): Promise<any> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

/** A lease, or `null` when the command should simply run (fail-open). */
export async function acquireHeavySlot(opts: AcquireOptions): Promise<HeavyLease | null> {
  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? Date.now;
  const started = now();
  let id: string | undefined;
  let said = false;
  try {
    for (;;) {
      const answer = await post(fetchFn, `${opts.base}/api/heavy-slot/acquire`, { label: opts.label, pid: opts.pid, id }, 25_000);
      if (answer?.state === "granted" && typeof answer.id === "string") {
        id = answer.id;
        break;
      }
      if (answer?.state !== "waiting" || typeof answer.id !== "string") return null;
      id = answer.id;
      if (!said) { said = true; opts.onWait?.(`[heavy-slot] ${opts.label}: waiting (${answer.reason})`); }
      if (now() - started >= opts.maxWaitMs) {
        // Leave the line before running: a waiter that runs anyway must not be admitted later for nothing.
        await post(fetchFn, `${opts.base}/api/heavy-slot/release`, { id }, 3_000).catch(() => {});
        opts.onWait?.(`[heavy-slot] ${opts.label}: waited ${Math.round(opts.maxWaitMs / 1000)}s, running anyway`);
        return null;
      }
    }
  } catch {
    return null;
  }

  const leaseId = id!;
  const every = opts.renewEveryMs ?? 30_000;
  const timer = every > 0
    ? setInterval(() => { void post(fetchFn, `${opts.base}/api/heavy-slot/renew`, { id: leaseId }, 3_000).catch(() => {}); }, every)
    : null;
  timer?.unref();
  let released = false;
  return {
    id: leaseId,
    waitedMs: now() - started,
    release: async () => {
      if (released) return;
      released = true;
      if (timer) clearInterval(timer);
      await post(fetchFn, `${opts.base}/api/heavy-slot/release`, { id: leaseId }, 3_000).catch(() => {});
    },
  };
}
