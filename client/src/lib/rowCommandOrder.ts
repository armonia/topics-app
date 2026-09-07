/**
 * WHICH COMMANDS THE TRAILING RAIL SHOWS, AND IN WHICH ORDER.
 *
 * Every row-like surface in the app ends in the same rail (`.row-actions` in
 * index.css): a tab in the tab bar, a chat row in the sidebar, a tree row. The
 * rail was born holding exactly one command, the one that DISMISSES the
 * surface — close the tab, archive the chat — and while a turn was running the
 * only way to interrupt it was to hover the loader itself, which then swapped
 * its ring for a stop square. Two different affordances for two commands that
 * belong to the same instant, one of them hidden inside a status glyph.
 *
 * The rule is an order, and it is the order of the decision: while something is
 * running, STOP comes before CLOSE, because closing a surface whose turn is
 * still alive is the second half of the same thought and never the first. When
 * nothing is running there is nothing to stop, and the rail is what it always
 * was.
 *
 * It lives in its own module, taking booleans and returning strings, because
 * two surfaces have to agree on it and neither of them can be asked in a unit
 * test: `PaneTabBar` needs a whole layout to render a tab, `TopicItem` a whole
 * sidebar. The sequence itself is the part that can be wrong, so the sequence
 * is the part that is testable on its own.
 */

/**
 * A trailing command.
 *  · `stop`  — interrupt the running turn. Same command the chat composer
 *    fires, never a different one.
 *  · `close` — the surface's own dismiss: close the tab in the tab bar,
 *    archive the row in the sidebar. One name, because from the rail's point of
 *    view they occupy the same slot and answer the same question.
 */
export type RowCommand = 'stop' | 'close';

/**
 * The rail's contents, left to right.
 *
 * @param canStop   there is a turn running here AND a handler to stop it.
 * @param closable  this surface can be dismissed at all (a structurally-owned
 *                  pane cannot; its rail may still exist for other commands).
 */
export function rowCommandSequence(canStop: boolean, closable = true): RowCommand[] {
  const commands: RowCommand[] = [];
  if (canStop) commands.push('stop');
  if (closable) commands.push('close');
  return commands;
}
