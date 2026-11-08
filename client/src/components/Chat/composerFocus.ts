/**
 * WHO MAY TAKE THE FOCUS when a chat pane becomes the focused one.
 *
 * The pane hands the focus to its composer a moment after it becomes active,
 * so a click on the tab or on the transcript lets a person write at once. The
 * same activation also follows a press on a control INSIDE the pane: Enter on
 * a fold header bubbles to the panel as a click and makes the pane the focused
 * one. The header then holds the focus on purpose, and taking it away sent the
 * next Space (the one that closes the fold) into the textarea.
 */

/** Controls a person puts the focus on to use them, not to write. */
const CONTROL = 'button, a, input, textarea, select, summary, [role="button"], [role="menuitem"], [role="tab"], [role="switch"], [contenteditable="true"]';

/**
 * Whether the composer may take the focus from `active` (what holds it as the
 * pane becomes active): not from a control inside the pane itself.
 */
export function composerMayTakeFocus(active: Element | null, paneRoot: Element | null): boolean {
  if (!active || !paneRoot || !paneRoot.contains(active)) return true;
  return !active.matches(CONTROL);
}
