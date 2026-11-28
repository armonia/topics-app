/** Builds the waits on the app's own parts and starts their check round. With no mailbox declared no wait can be made. */
import type { Database } from "bun:sqlite";
import type { TaskService } from "../../services/tasks";
import { currentMailboxes } from "../inbox/wiring";
import { wakeCardFromWait, type CardRequeued } from "./card-wake";
import { createMailWaits } from "./service";
import type { MailWait } from "./store";

export interface WaitsWiring {
  db: Database;
  svc: Pick<TaskService, "addComment">;
  now: () => Date;
  /** A card went back to the queue: the board is told and the dispatcher looks at it. */
  onCardRequeued: (card: CardRequeued) => void;
  /** The chat side; unset until the boot has a route to send through. */
  wakeChat: () => ((wait: MailWait) => Promise<"done" | "retry" | "gone">) | null;
  chatOpen: (sessionKey: string) => boolean;
}

export function startMailWaits(w: WaitsWiring) {
  const waits = createMailWaits({
    db: w.db, now: w.now, mailboxes: currentMailboxes,
    owners: {
      isOpen: (kind, id) => {
        if (kind === "chat") return w.chatOpen(id);
        const row = w.db.query("SELECT status, archived FROM tasks WHERE id = ?").get(id) as { status: string; archived: number } | null;
        return !!row && row.status !== "done" && row.archived !== 1;
      },
      wakeCard: (wait) => {
        const { requeued } = wakeCardFromWait(w.db, w.svc, wait, w.now());
        if (requeued) w.onCardRequeued(requeued);
        return "done";
      },
      wakeChat: async (wait) => (w.wakeChat()?.(wait) ?? "retry"),
    },
  });
  waits.start();
  return waits;
}
