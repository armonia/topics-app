/**
 * THE SERVICE OF THE WAITS (rules P3 to P5): creating, ending and waking.
 *
 * `sweep` is the check round of the server: it expires the waits past their
 * deadline, withdraws those whose owner is gone, and delivers the wakes that
 * are owed. It reads only this table and the owner's own state, so it runs
 * with the receiving round stopped, with the mailbox's switch off, and after a
 * restart: nothing it needs lives in memory. A wake goes out with the wait id
 * as its key, and the mark `delivered` is written after it, so a stop between
 * the two repeats a delivery the key makes harmless.
 */
import type { Database } from "bun:sqlite";
import type { Mailbox } from "../inbox/mailboxes";
import type { StoredMessage } from "../inbox/store";
import {
  cancelWait, countOpen, createWait, expireDue, getWait, listOpenWaits, markWake, matchWaits, nextExpiry, pendingWakes,
  type CreatedWait, type MailWait, type NewWait, type WaitOwnerKind,
} from "./store";

/** What the service needs from the cards and the chats; production fills it in `wiring.ts`. */
export interface WaitOwners {
  /** False once the owner is closed for good: a finished or archived card, an archived chat. */
  isOpen(kind: WaitOwnerKind, id: string): boolean;
  /** Puts the card back in the queue with the wake as its note. `retry` when it could not be done yet. */
  wakeCard(wait: MailWait): "done" | "retry";
  /** One turn for the chat, keyed by the wait id. `retry` when the chat is busy or held; `gone` when it cannot be woken at all. */
  wakeChat(wait: MailWait): Promise<"done" | "retry" | "gone">;
}

export interface MailWaitsOptions {
  db: Database;
  mailboxes: () => Mailbox[];
  owners: WaitOwners;
  now?: () => Date;
  newId?: () => string;
}

const BEAT_MS = 5_000;

export function createMailWaits(options: MailWaitsOptions) {
  const { db, owners } = options;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => crypto.randomUUID());

  function create(input: Omit<NewWait, "id">): CreatedWait {
    return createWait(db, { ...input, id: newId() }, options.mailboxes(), now());
  }

  /** The hook of the receiving round, run inside its transaction. */
  function onStored(box: Mailbox, fresh: StoredMessage[]): void {
    matchWaits(db, box, fresh, now());
  }

  /** One check round. Never throws: a wake that fails stays owed to the next round. */
  async function sweep(): Promise<{ expired: number; delivered: number; dropped: number; cancelled: number }> {
    const out = { expired: 0, delivered: 0, dropped: 0, cancelled: 0 };
    out.expired = expireDue(db, now()).length;
    for (const wait of listOpenWaits(db)) {
      if (!owners.isOpen(wait.ownerKind, wait.ownerId) && cancelWait(db, wait.id, now(), "the owner is closed")) out.cancelled++;
    }
    for (const wait of pendingWakes(db)) {
      if (!owners.isOpen(wait.ownerKind, wait.ownerId)) {
        if (markWake(db, wait.id, "dropped")) out.dropped++;
        continue;
      }
      let verdict: "done" | "retry" | "gone";
      try {
        verdict = wait.ownerKind === "card" ? owners.wakeCard(wait) : await owners.wakeChat(wait);
      } catch (error) {
        console.warn(`[mail-wait] wake of ${wait.id} failed:`, error);
        verdict = "retry";
      }
      if (verdict === "retry") continue;
      if (markWake(db, wait.id, verdict === "done" ? "delivered" : "dropped")) out[verdict === "done" ? "delivered" : "dropped"]++;
    }
    return out;
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  return {
    create,
    onStored,
    sweep,
    get: (id: string) => getWait(db, id),
    cancel: (id: string) => cancelWait(db, id, now(), "cancelled by request"),
    nextExpiry: (mailbox: string) => nextExpiry(db, mailbox),
    openCount: (mailbox: string) => countOpen(db, mailbox),
    start(): void {
      if (timer) return;
      timer = setInterval(() => {
        if (running) return;
        running = true;
        void sweep().catch((error) => console.warn("[mail-wait] check round failed:", error)).finally(() => { running = false; });
      }, BEAT_MS);
      timer.unref?.();
    },
    stop(): void { if (timer) clearInterval(timer); timer = null; },
  };
}

export type MailWaits = ReturnType<typeof createMailWaits>;
