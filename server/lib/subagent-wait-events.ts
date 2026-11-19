/**
 * A chat's sub-agents changed under it: one started, ended, opened or closed a
 * turn, or left a result that has not reached the chat yet.
 *
 * The attention state of the parent chat names what it waits on
 * (`withSubagentTask`), so it must hear about every one of these when it
 * happens and not only at the parent's next turn end: a child that finishes
 * minutes after the parent closed its turn is the case this exists for
 * (BGVIS-10). Its own module, like `command-background.ts` for commands, so the
 * store and the runtime can announce without importing the attention wiring.
 */
let observer: ((parentSessionKey: string) => void) | null = null;

/** The one listener: `boot/tracker.ts` rewrites the chat's task map. */
export function observeSubagentWaitChanged(fn: ((parentSessionKey: string) => void) | null): void {
  observer = fn;
}

/** Announce that the sub-agents of `parentSessionKey` changed. Never throws: a listener must not break a write. */
export function noteSubagentWaitChanged(parentSessionKey: string | null | undefined): void {
  if (!parentSessionKey || !observer) return;
  try { observer(parentSessionKey); } catch (err) { console.warn("[subagent-wait] observer failed:", err); }
}
