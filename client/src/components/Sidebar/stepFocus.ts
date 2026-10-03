/**
 * THE NEXT CONTROL ON TAB, inside a form that walks its own Tab order
 * (`FormPanelFrame`): forward or back by one, wrapping at the two ends. From
 * outside the list (the frame itself focused) Tab enters on the first control
 * and Shift+Tab on the last. Pure, so the rule is tested without a DOM.
 */
export function stepFocus<T>(items: readonly T[], active: T | null, back: boolean): T {
  const at = active === null ? -1 : items.indexOf(active);
  if (at === -1) return back ? items[items.length - 1]! : items[0]!;
  const next = (at + (back ? -1 : 1) + items.length) % items.length;
  return items[next]!;
}
