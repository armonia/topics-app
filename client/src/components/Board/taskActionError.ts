/**
 * The message of a FAILED action on a card, in the reader's language.
 *
 * The server answers 409 with an English sentence written for an agent ("task
 * has open subtasks..."): on the board a person reads it, at the moment their
 * click did nothing. Here it becomes the sentence that also says WHAT TO DO,
 * once for every surface (card and drawer use this, not each its own), through
 * the i18n catalogues: the caller passes its `tr`, because this module is PURE
 * (no React, no locale of its own). Where the error is DRAWN is the caller's
 * decision: next to the button pressed, not in the bar on top of the board.
 */

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

/**
 * @param raw the raw error (usually the API's `Error.message`).
 * @param tr the caller's translate function.
 * @param fallback what to say when `raw` is empty (defaults to "action failed").
 */
export function taskActionErrorMessage(raw: unknown, tr: Translate, fallback?: string): string {
  const text = (raw instanceof Error ? raw.message : String(raw ?? '')).trim();
  if (!text) return fallback ?? tr('board.actionError.failed');
  // The gate that surprises whoever approves: the parent does not close while a
  // child is open, and the child is visible on the card (the checklist expands in review).
  if (/open subtasks/i.test(text)) return tr('board.actionError.openSubtasks');
  // "Stop" on a card with no turn in flight. The 409 was already there, but its
  // sentence is written for an agent: the reader is a person who just pressed a
  // button and saw nothing happen. This one also names the move that sets the
  // card in motion again, the only one available from Backlog.
  if (/no active agent/i.test(text)) return tr('board.actionError.noActiveAgent');
  // The pre-review checks gate. The server's sentence names the remedy an API
  // CALLER has (`force: true`) and prints it at a person looking at a card,
  // where that field does not exist. Here it names the remedy that is actually
  // under the thumb: the button that says "anyway". The red check's name is
  // kept, because it is the only part that says what to look at.
  if (/checks pre-review sono ROSSI/i.test(text)) {
    const red = /`([^`]+)`/.exec(text)?.[1];
    return tr('board.actionError.checksRed', { red: red ? ` (${red})` : '' });
  }
  return text;
}
