/**
 * The register of PTY creates waiting for the bridge to acknowledge them.
 *
 * A `POST /api/terminal/sessions` parks here until the bridge answers
 * `{type:'created', id, pid}` or `{type:'error'}`. Without that gate the API
 * used to return 200 for a session the bridge had never actually spawned, and
 * whoever asked for a terminal got an empty pane and no clue why.
 *
 * WHY IT IS ITS OWN FILE: THE LATE ANSWER USED TO KILL THE SERVER.
 *
 * Measured on a Windows machine during an e2e run (card 9a577eb9): the bridge
 * was not connected, so `POST /sessions` correctly answered 502 in a few
 * milliseconds. Five seconds later the server process was gone:
 *
 *   error: Bridge did not ack create within 5000ms
 *   Bun v1.3.14 (Windows x64)
 *
 * The 502 was right. What was wrong is that the caller had ALREADY given up
 * when the deadline fired. The waiting promise is created BEFORE the message
 * is written to the socket; when that write throws synchronously ("Bridge not
 * connected") the `await` on the promise is never reached, so its later
 * rejection has no recipient. Bun treats an unhandled rejection as fatal, so
 * one unreachable bridge took down the whole server: every other terminal,
 * every chat, every open topic. The cost is not academic — that run lost 163
 * specs to ECONNREFUSED after the process died mid-shard, and a person on
 * Windows loses their server rather than their terminal.
 *
 * Deleting the map entry, which is what the old code did on the failed write,
 * does not help: the entry is the ROUTING of the answer, the `setTimeout` is
 * what produces it. Dropping the first while leaving the second running is
 * precisely how the rejection ends up with nobody to catch it.
 *
 * So this register holds two guarantees that a caller cannot forget:
 *
 *   1. every promise it hands out is born ALREADY HANDLED. An internal no-op
 *      catch is attached at creation, so no path — deadline, superseded
 *      create, bridge error, or a caller that walked away — can ever raise an
 *      unhandled rejection. Whoever awaits still sees the real error: a second
 *      handler does not consume the first.
 *   2. `cancel()` clears the timer, so a create the caller abandoned stops
 *      counting down instead of leaving a five-second fuse behind.
 *
 * The first guarantee is what keeps the process alive; the second is what
 * keeps it tidy. Only the first is load-bearing, which is why it lives in the
 * constructor of every wait rather than in a rule callers must remember.
 */

export const DEFAULT_CREATE_ACK_TIMEOUT_MS = 5000;

type PendingCreate = {
  resolve: (pid: number) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class BridgeCreateAcks {
  private readonly pending = new Map<string, PendingCreate>();

  /**
   * Park until the bridge acks `id`, or until `timeoutMs` elapses.
   *
   * A second wait for the same id fails the earlier one explicitly instead of
   * overwriting it: an overwritten entry leaked its timer, the first waiter
   * never settled, and the orphan timer later deleted the map entry belonging
   * to the SECOND create, stealing its ack.
   */
  wait(id: string, timeoutMs: number = DEFAULT_CREATE_ACK_TIMEOUT_MS): Promise<number> {
    const previous = this.pending.get(id);
    if (previous) {
      clearTimeout(previous.timer);
      this.pending.delete(id);
      previous.reject(new Error(`Superseded by a newer create for session ${id}`));
    }

    let resolve!: (pid: number) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<number>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Guarantee 1. Attached here, before any code can await it or fail to.
    promise.catch(() => {});

    const timer = setTimeout(() => {
      // Only drop the entry if it is still OURS: a later create may have
      // replaced it between the timer firing and this line.
      if (this.pending.get(id)?.timer === timer) this.pending.delete(id);
      reject(new Error(`Bridge did not ack create within ${timeoutMs}ms`));
    }, timeoutMs);

    this.pending.set(id, { resolve, reject, timer });
    return promise;
  }

  /** The bridge spawned the pty: hand the pid to whoever is waiting. */
  settle(id: string, pid: number): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve(pid);
  }

  /** The bridge refused this create: fail its waiter with the bridge's words. */
  fail(id: string, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.reject(error);
  }

  /**
   * The bridge reported an error without saying which create it belongs to
   * (it answers from a catch block that does not know the id). Everyone
   * waiting is a suspect, so everyone is told.
   */
  failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  /**
   * The caller gave up before the bridge could answer (the write to the socket
   * threw). Stop the countdown: nobody is left to receive its verdict.
   */
  cancel(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
  }

  has(id: string): boolean {
    return this.pending.has(id);
  }

  get size(): number {
    return this.pending.size;
  }
}
