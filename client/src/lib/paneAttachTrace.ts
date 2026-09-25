/**
 * One line for each decision between `open_browser_pane` and an attached
 * `/ws/browser/<ctx>` socket.
 *
 * The 24/09 incident (card c5c1c68f) left nothing to read on the client side.
 * The server log showed a pane socket closing two seconds after a reconnect,
 * and a force-open that attached nothing fourteen minutes later. Every theory
 * about what happened in between came from reading code. These lines are what
 * the next occurrence must leave behind: which project windows saw the
 * broadcast, whether the pane existed and in which cell, which branch
 * force-open took, and what unmounted the pane.
 *
 * TWO DESTINATIONS. The console, for whoever has the inspector open, and the
 * SERVER LOG, because the desktop client is a WKWebView whose console nobody
 * reads after the fact: the log is where an incident gets read a day later.
 * Lines reach the server in batches (`POST /api/client-trace`), once the app
 * has installed the sink at boot (`main.tsx`). Unit tests never install it, so
 * tracing there starts no timer and no fetch.
 *
 * Not a debug flag: these events are rare (a handful per browser opening), and
 * a flag nobody turned on logs nothing.
 */

export interface TraceEvent {
  at: number;
  event: string;
  fields: Record<string, unknown>;
}

/** Sends one batch; resolves true when the server took it. */
export type TraceSend = (events: TraceEvent[]) => Promise<boolean>;

/** The server takes at most this many events per request. */
const BATCH = 50;
/** Kept while the server cannot be reached; the oldest go first past it. */
const MAX_QUEUED = 200;
/** Lines that happen together travel together. */
const FLUSH_DELAY_MS = 500;
/** A server that is restarting is back within seconds: first retry soon. */
const RETRY_DELAY_MS = 5_000;
/** A server that stays unreachable is asked less and less often, up to this. */
const MAX_RETRY_DELAY_MS = 5 * 60_000;

let send: TraceSend | null = null;
const queue: TraceEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let dropped = 0;
// One batch at a time: two in flight could come back failed in either order,
// and put their lines back out of order.
let sending = false;
let retryDelay = RETRY_DELAY_MS;

function schedule(ms: number): void {
  if (timer || !send) return;
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, ms);
}

async function flush(): Promise<void> {
  if (!send || sending || queue.length === 0) return;
  sending = true;
  const batch = queue.splice(0, BATCH);
  // The count of lines lost to the cap rides in front of the batch, and is
  // cleared only once a batch carrying it got through.
  const lost = dropped;
  if (lost > 0) {
    batch.unshift({ at: Date.now(), event: 'trace lines dropped', fields: { count: lost } });
    if (batch.length > BATCH) queue.unshift(batch.pop()!);
  }
  let ok = false;
  try {
    ok = await send(batch);
  } catch {
    ok = false;
  } finally {
    sending = false;
  }
  if (!ok) {
    // Most likely the server is down (a restart), which is exactly when these
    // lines matter: put them back and try again, bounded.
    queue.unshift(...(lost > 0 ? batch.slice(1) : batch));
    trimQueue();
    schedule(retryDelay);
    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
    return;
  }
  retryDelay = RETRY_DELAY_MS;
  dropped -= lost;
  if (queue.length > 0) schedule(0);
}

function trimQueue(): void {
  if (queue.length <= MAX_QUEUED) return;
  dropped += queue.length - MAX_QUEUED;
  queue.splice(0, queue.length - MAX_QUEUED);
}

export function tracePaneAttach(event: string, fields: Record<string, unknown> = {}): void {
  console.info('[pane-attach]', event, fields);
  if (!send) return;
  queue.push({ at: Date.now(), event, fields });
  trimQueue();
  schedule(FLUSH_DELAY_MS);
}

/**
 * Start sending the trace to the server. Called once, at app boot. A refusal
 * the page can read (4xx: a guest, or a server without the route, on the web)
 * turns the sink off for this page. A network error or a 5xx is retried with
 * a growing delay, and so is a refusal the page cannot read: under Tauri the
 * app can be newer than its server, whose 404 carries no CORS header, so the
 * fetch fails like a network error. Asked every 5 minutes at most, that costs
 * nothing, and a server that comes back gets the lines.
 */
export function installPaneAttachTraceSink(clientId: () => string): void {
  if (send || typeof fetch !== 'function') return;
  send = async (events) => {
    const res = await fetch('/api/client-trace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Id': clientId() },
      body: JSON.stringify({ events }),
      keepalive: true,
    });
    if (res.status >= 400 && res.status < 500) {
      send = null;
      queue.length = 0;
      return true;
    }
    return res.ok;
  };
}

// ─── test-only ─────────────────────────────────────────────────────────────
/** Test-only: plug a transport and reset the queue. */
export function __setPaneAttachTraceSendForTests(next: TraceSend | null): void {
  send = next;
  queue.length = 0;
  dropped = 0;
  sending = false;
  retryDelay = RETRY_DELAY_MS;
  if (timer) clearTimeout(timer);
  timer = null;
}
/** Test-only: flush now instead of waiting for the timer. */
export async function __flushPaneAttachTraceForTests(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  await flush();
}
/** Test-only: the delay the next retry will wait. */
export function __retryDelayForTests(): number {
  return retryDelay;
}
/** Test-only: what is still waiting to be sent. */
export function __queuedPaneAttachTraceForTests(): TraceEvent[] {
  return [...queue];
}
