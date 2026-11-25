/**
 * `send_to_agent` while the caller's project is paused (project quota brake).
 *
 * A message to a child wakes or re-seeds it: a turn that no person typed, so a
 * paused project does not start it (`services/turn-gate.ts`). The message is
 * not dropped: it waits here, under the child, and goes out on "Continua".
 *
 * Several messages to the same child while paused are ONE parked send with
 * their texts joined in order: the gate keeps one thunk per key, and a second
 * message must not replace the first one's words.
 */
import { holdUntilResumed } from "../services/turn-gate";

const pending = new Map<string, string[]>();

/** A resume that meets a child still busy (409) is tried again: its turn ends by itself. */
const RETRY_STATUS = 409;
const MAX_TRIES = 6;
const DEFAULT_RETRY_MS = 5_000;

export function holdChildSend(
  projectId: string,
  childId: string,
  input: string,
  /** Sends the joined text through the same route the caller used (the gate passes once the project runs again). */
  replay: (joinedInput: string) => Promise<Response | null>,
  retryMs: number = DEFAULT_RETRY_MS,
): void {
  const list = pending.get(childId) ?? [];
  list.push(input);
  pending.set(childId, list);
  holdUntilResumed(projectId, `child-send:${childId}`, async () => {
    const inputs = pending.get(childId) ?? [];
    pending.delete(childId);
    if (!inputs.length) return;
    const joined = inputs.join("\n\n");
    for (let i = 0; i < MAX_TRIES; i++) {
      const res = await replay(joined);
      if (res?.status !== RETRY_STATUS) {
        if (res && !res.ok) console.warn(`[held-child-send] ${childId}: the resumed message was refused (HTTP ${res.status})`);
        return;
      }
      await new Promise((r) => setTimeout(r, retryMs));
    }
    console.warn(`[held-child-send] ${childId}: still busy after ${MAX_TRIES} tries, the message was not delivered`);
  });
}

/** @internal Test seam. */
export function resetHeldChildSendsForTests(): void { pending.clear(); }
