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
  /** Renewal cadence while the command runs; 0 disables (tests, and shell hooks: a pid lease lives while the pid does). */
  renewEveryMs?: number;
}

/**
 * Topics serves TLS on its own when it finds certificates (self-signed, loopback
 * only), so a plain `http://127.0.0.1:3333` is refused on a real install and a
 * fail-open client would skip the queue forever, silently. The certificate check
 * is relaxed for loopback hosts only: elsewhere it would be an open MITM.
 */
function isLoopback(url: string): boolean {
  try { return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname); } catch { return false; }
}

function loopbackCertInit(url: string): RequestInit {
  return (isLoopback(url) ? { tls: { rejectUnauthorized: false } } : {}) as RequestInit;
}

/**
 * Where Topics listens: `TOPICS_URL` when set, else https then http on the local
 * port (the order the server itself prefers). `null` when nothing answers.
 */
export async function resolveHeavyBase(opts: { url?: string; port?: number | string; fetchFn?: typeof fetch }): Promise<string | null> {
  if (opts.url) return opts.url.replace(/\/$/, "");
  const fetchFn = opts.fetchFn ?? fetch;
  for (const scheme of ["https", "http"]) {
    const base = `${scheme}://127.0.0.1:${opts.port || 3333}`;
    try {
      const res = await fetchFn(`${base}/api/heavy-slot`, { signal: AbortSignal.timeout(2_000), ...loopbackCertInit(base) });
      if (res.ok) return base;
    } catch { /* try the next scheme */ }
  }
  return null;
}

async function post(fetchFn: typeof fetch, url: string, body: unknown, timeoutMs: number): Promise<any> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    ...loopbackCertInit(url),
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

/** Frees a place by id. Never throws. */
export async function releaseHeavySlot(base: string, id: string, fetchFn: typeof fetch = fetch): Promise<void> {
  await post(fetchFn, `${base}/api/heavy-slot/release`, { id }, 3_000).catch(() => {});
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
