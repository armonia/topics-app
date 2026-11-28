/**
 * THE RECEIVING ROUND OF THE SERVER (rule P2).
 *
 * Not a job of the scheduled-jobs engine: a round of the server, one mailbox
 * at a time, under a lease kept in SQLite so two servers on the same file never
 * read the same mailbox together. Per mailbox and per round: ONE `list` call
 * (30 s at most), then one transaction (`commitRound`). Nothing of the state
 * lives in memory, so a restart loses nothing.
 *
 * Cadence: 60 s, 15 s for a mailbox with a wait that expires within 30 minutes.
 * Health: three failures in a row, or no good read for 10 minutes while a wait
 * is open, raise ONE alert to the owner (the engine's own alert door keeps it
 * to one per scope and day).
 */
import type { Database } from "bun:sqlite";
import { AdapterError, LIST_LIMIT, type ListAdapter } from "./contract";
import { isOwnAddress, isReadable, type Mailbox } from "./mailboxes";
import { commitRound, readState, recordFailure, releaseLease, takeLease, type StoredMessage } from "./store";

export const CADENCE_MS = 60_000;
export const FAST_CADENCE_MS = 15_000;
export const FAST_WINDOW_MS = 30 * 60_000;
export const STALE_AFTER_MS = 10 * 60_000;
export const FAILURES_BEFORE_ALERT = 3;
const LEASE_TTL_MS = 45_000;
const BEAT_MS = 5_000;

export interface InboxAlert { subject: string; scope: string; title: string; body: string }

export interface InboxOptions {
  db: Database;
  /** Read at every round: the person edits the list while the app runs. */
  mailboxes: () => Mailbox[];
  adapterFor: (box: Mailbox) => ListAdapter;
  now?: () => Date;
  /** Who holds the lease. One per server process. */
  owner?: string;
  /** Raised to the owner; production: the engine's owner alert. */
  alert: (alert: InboxAlert) => void;
  /** Hook of the waits track: sees the new rows inside the transaction. */
  onStored?: (box: Mailbox, fresh: StoredMessage[]) => void;
  /** Hook of the waits track: when the first open wait of the mailbox expires, or null. */
  nextWaitExpiry?: (mailbox: string) => Date | null;
  /** Hook of the waits track: how many waits are open on the mailbox. */
  openWaits?: (mailbox: string) => number;
}

export type RoundOutcome = "read" | "failed" | "not_due" | "busy" | "skipped";

export function createInbox(options: InboxOptions) {
  const { db } = options;
  const now = options.now ?? (() => new Date());
  const owner = options.owner ?? `inbox-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const more = new Set<string>();

  function intervalFor(box: Mailbox): number {
    const expiry = options.nextWaitExpiry?.(box.name) ?? null;
    return expiry && expiry.getTime() - now().getTime() <= FAST_WINDOW_MS ? FAST_CADENCE_MS : CADENCE_MS;
  }

  function isDue(box: Mailbox): boolean {
    if (more.has(box.name)) return true;
    const tried = readState(db, box.name).lastTryAt;
    return !tried || now().getTime() - Date.parse(tried) >= intervalFor(box);
  }

  /** One round of one mailbox. Never throws: a failure is written on the mailbox's state. */
  async function readMailbox(box: Mailbox): Promise<RoundOutcome> {
    if (!isReadable(box)) return "skipped";
    if (!isDue(box)) return "not_due";
    if (!takeLease(db, box.name, owner, now(), LEASE_TTL_MS)) return "busy";
    try {
      const state = readState(db, box.name);
      const sinceMs = now().getTime() - box.windowHours * 3_600_000;
      const list = options.adapterFor(box);
      let response = await list({ cursor: state.cursor, sinceMs, limit: LIST_LIMIT });
      // A cursor the provider forgot is never read as "from now": the last window is read again, and the unique key drops what is already in.
      if (response.expired) response = await list({ cursor: null, sinceMs, limit: LIST_LIMIT });
      if (response.expired) throw new AdapterError("the adapter still reports an expired cursor with no cursor");
      commitRound(db, {
        mailbox: box.name, messages: response.messages, cursor: response.cursor ?? state.cursor, now: now(),
        isOwn: (from) => isOwnAddress(box, from),
        onStored: (fresh) => options.onStored?.(box, fresh),
      });
      if (response.more) more.add(box.name); else more.delete(box.name);
      return "read";
    } catch (error) {
      more.delete(box.name);
      recordFailure(db, box.name, error instanceof Error ? error.message : String(error), now());
      return "failed";
    } finally {
      releaseLease(db, box.name, owner);
    }
  }

  function checkHealth(box: Mailbox): void {
    const state = readState(db, box.name);
    const subject = `mail:${box.name}`;
    if (state.failures >= FAILURES_BEFORE_ALERT) {
      options.alert({
        subject, scope: `mail-inbox:${box.name}:failing`,
        title: `Mail "${box.name}" cannot be read`,
        body: `${state.failures} reads in a row failed: ${state.lastError ?? "no detail"}.`,
      });
    }
    const waiting = options.openWaits?.(box.name) ?? 0;
    if (waiting > 0 && state.lastOkAt && now().getTime() - Date.parse(state.lastOkAt) > STALE_AFTER_MS) {
      options.alert({
        subject, scope: `mail-inbox:${box.name}:stale`,
        title: `Mail "${box.name}" is not up to date`,
        body: `${waiting} wait(s) are open and the last good read was at ${state.lastOkAt}.`,
      });
    }
  }

  /** One beat: every readable mailbox that is due, one after the other. */
  async function tick(): Promise<Record<string, RoundOutcome>> {
    const outcomes: Record<string, RoundOutcome> = {};
    for (const box of options.mailboxes()) {
      outcomes[box.name] = await readMailbox(box);
      if (outcomes[box.name] !== "skipped") checkHealth(box);
    }
    return outcomes;
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  return {
    tick,
    readMailbox,
    start(): void {
      if (timer) return;
      timer = setInterval(() => {
        if (running) return;
        running = true;
        void tick().catch((error) => console.warn("[mail] inbox beat failed:", error)).finally(() => { running = false; });
      }, BEAT_MS);
      timer.unref?.();
    },
    stop(): void { if (timer) clearInterval(timer); timer = null; },
  };
}

